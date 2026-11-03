import { describe, expect, it } from 'vitest';
import { Mailbox, collaborationTool, controlTool } from '../src/messaging/index.js';
import { leanTaskCardIssue } from '../src/messaging/task-spawn.js';
import { leanBuiltinAgentCards } from '../src/agents/card.js';
import { declareTasks } from '../src/runtime/task-declare.js';
import { moveTaskNode, readTaskGraph } from '../src/runtime/task-graph.js';
import { answer, fixture } from './helpers.js';
import type { Message } from '../src/runtime/types.js';

function team() {
  const f = fixture(undefined, ['read', 'write', 'exec'], { toolProfile: 'lean-team', taskProtocol: 3, instructions: { global: false } });
  const store = f.app.store;
  const main = store.run(f.runId);
  return { ...f, store, main };
}

describe('lean team collaboration tools', () => {
  it('registers the three graph tools only for team mains and dispatches to the synchronous host', () => {
    const f = team();
    const operations: string[] = [];
    const mailbox = new Mailbox(f.store, () => {}, { taskOperation: (_run, _callId, name, args) => { operations.push(name); return args; } });
    expect(mailbox.specs(f.main).map(tool => tool.name)).toEqual(['delegate', 'task', 'find_agents', 'ask_user']);
    expect(mailbox.specs({ ...f.main, parentId: f.main.id })).toEqual([]);
    expect(['delegate', 'task', 'find_agents'].every(collaborationTool)).toBe(true);
    const args = mailbox.validate(f.main, 'delegate', JSON.stringify({ tasks: [{ id: 'one', goal: 'Read one module' }] }));
    expect(mailbox.execute(f.main, 'd1', 'delegate', args)).toEqual(args);
    expect(operations).toEqual(['delegate']);
    expect(() => mailbox.validate(f.main, 'delegate', JSON.stringify({ tasks: [{ goal: 'Missing node ID' }] }))).toThrow('schema');
    f.store.putSession({ ...f.store.session(f.main.sessionId), toolProfile: 'full' });
    expect(mailbox.specs(f.main).some(tool => ['delegate', 'task', 'find_agents'].includes(tool.name))).toBe(false);
    expect(() => mailbox.execute(f.main, 'd2', 'delegate', args)).toThrow('lean-team main');
  });

  it('treats only task wait as a control call and fails explicitly without a task host', () => {
    const f = team();
    expect(controlTool('task', { action: 'wait' })).toBe(true);
    expect(controlTool('task', { action: 'inspect' })).toBe(false);
    expect(controlTool('ask_user')).toBe(true);
    expect(() => new Mailbox(f.store, () => {}).execute(f.main, 'x', 'task', { action: 'inspect' })).toThrow('task graph host is not installed');
  });
});

describe('graph waits', () => {
  it.each(['any', 'all'] as const)('ignores unrelated self work and failures in a %s wait', mode => {
    const f = team();
    const mailbox = new Mailbox(f.store, () => {});
    declareTasks(f.store, f.main.id, { tasks: [{ id: 'mine', owner: 'self', goal: 'Independent main work' }, { id: 'broken', goal: 'Unrelated failure' }, { id: 'child', goal: 'Independent child' }] });
    const nodes = readTaskGraph(f.store, f.main.id).nodes;
    moveTaskNode(f.store, f.main.id, moveTaskNode(f.store, f.main.id, nodes[1]!, 'queued'), 'failed');
    let child = moveTaskNode(f.store, f.main.id, nodes[2]!, 'queued');
    child = moveTaskNode(f.store, f.main.id, child, 'running');
    const wait = mailbox.waitForTasks(f.main, ['child'], mode);
    f.store.updateRun(f.main.id, { status: 'waiting' });
    mailbox.refresh(f.main.id);
    expect(f.store.wait(wait.waitId).status).toBe('registered');
    child = moveTaskNode(f.store, f.main.id, child, 'integrating');
    mailbox.refresh(f.main.id);
    expect(f.store.wait(wait.waitId).status).toBe('registered');
    moveTaskNode(f.store, f.main.id, child, 'done');
    mailbox.refresh(f.main.id);
    expect(f.store.wait(wait.waitId)).toMatchObject({ status: 'settled', reason: 'conditions_met' });
  });

  it('keeps a durable wait across child completion and integration, then wakes when the node finishes', () => {
    const f = team();
    const mailbox = new Mailbox(f.store, () => {});
    declareTasks(f.store, f.main.id, { tasks: [{ id: 'one', goal: 'Change one module' }] });
    let node = readTaskGraph(f.store, f.main.id).nodes[0]!;
    node = moveTaskNode(f.store, f.main.id, node, 'queued');
    node = moveTaskNode(f.store, f.main.id, node, 'running');
    const wait = mailbox.waitForTasks(f.main, ['one'], 'all');
    f.store.updateRun(f.main.id, { status: 'waiting' });
    node = moveTaskNode(f.store, f.main.id, node, 'integrating');
    mailbox.refresh(f.main.id);
    expect(f.store.wait(wait.waitId)).toMatchObject({ status: 'registered', eventDriven: true, taskNodeIds: ['one'] });
    f.store.putWait({ ...f.store.wait(wait.waitId), deadline: 0 });
    mailbox.refresh(f.main.id);
    expect(f.store.wait(wait.waitId).status).toBe('registered');
    expect(f.store.run(f.main.id).status).toBe('waiting');
    moveTaskNode(f.store, f.main.id, node, 'done');
    mailbox.refresh(f.main.id);
    expect(f.store.wait(wait.waitId)).toMatchObject({ status: 'settled', reason: 'conditions_met' });
    expect(f.store.run(f.main.id).status).toBe('queued');
  });

  it('returns immediately when blocked on unfinished self work rather than waiting forever', () => {
    const f = team();
    const mailbox = new Mailbox(f.store, () => {});
    declareTasks(f.store, f.main.id, { tasks: [{ id: 'self', owner: 'self', goal: 'Define the interface' }, { id: 'child', goal: 'Use interface', after: ['self'] }] });
    const wait = mailbox.waitForTasks(f.main, ['child']);
    expect(f.store.wait(wait.waitId)).toMatchObject({ status: 'settled', reason: 'conditions_met' });
    expect(() => mailbox.waitForTasks(f.main, ['missing'])).toThrow('does not exist');
  });
});

describe('host task creation', () => {
  it('reports unsupported custom contracts instead of dropping input or report requirements', () => {
    const card = leanBuiltinAgentCards[0]!;
    expect(leanTaskCardIssue(card)).toBeUndefined();
    expect(leanTaskCardIssue({ ...card, inputs: [{ name: 'contract', kind: 'artifact', required: true }] })).toContain('named inputs (contract)');
    expect(leanTaskCardIssue({ ...card, report: [{ name: 'findings', kind: 'list', required: false }] })).toContain('report.submit');
  });
  it('uses the reserved ID and retains resume context but starts redo with only a bounded summary', () => {
    const f = team();
    const mailbox = f.app.coordinator.mailbox;
    const first = mailbox.spawnTaskHost(f.main.id, { runId: 'first-child', nodeId: 'read', generation: 1, role: 'explorer', goal: 'Locate an entry point', start: ['src/entry.ts'] });
    expect(first).toMatchObject({ id: 'first-child', taskNode: { ownerId: f.main.id, nodeId: 'read', generation: 1, role: 'explorer' }, permissions: ['read'] });
    expect(first.execution).toBeUndefined();
    const history = [...f.store.readBlob<Message[]>(first.contextRef), { role: 'assistant' as const, content: 'OLD_CONTEXT_MARKER' }];
    f.store.updateRun(first.id, { status: 'completed', contextRef: f.store.blob(history), resultRef: f.store.blob({ text: 'Entry is src/entry.ts' }) });
    const resumed = mailbox.spawnTaskHost(f.main.id, { runId: 'resumed-child', nodeId: 'read', generation: 1, role: 'explorer', goal: 'Check its caller', continuation: { mode: 'resume', fromRunId: first.id } });
    expect(resumed.agentId).toBe(first.agentId);
    expect(JSON.stringify(f.store.readBlob(resumed.contextRef))).toContain('OLD_CONTEXT_MARKER');
    f.store.updateRun(resumed.id, { status: 'completed', resultRef: f.store.blob({ text: 'Caller is src/caller.ts' }) });
    const redone = mailbox.spawnTaskHost(f.main.id, { runId: 'redone-child', nodeId: 'read', generation: 2, role: 'explorer', goal: 'Read the current entry', continuation: { mode: 'redo', fromRunId: resumed.id } });
    expect(redone).toMatchObject({ agentId: first.agentId, continuationOf: resumed.id });
    expect(redone.historyFrom).toBeUndefined();
    expect(JSON.stringify(f.store.readBlob(redone.contextRef))).not.toContain('OLD_CONTEXT_MARKER');
    expect(JSON.stringify(f.store.readBlob(redone.contextRef))).toContain('Caller is src/caller.ts');
    expect(() => mailbox.spawnTaskHost(f.main.id, { runId: 'redone-child', nodeId: 'other', generation: 2, role: 'explorer', goal: 'Wrong ID' })).toThrow('another task');
  });

  it('does not send the legacy terminal notice before the host integrates a graph child', () => {
    const f = team();
    const child = f.app.coordinator.mailbox.spawnTaskHost(f.main.id, { runId: 'child', nodeId: 'one', generation: 1, role: 'explorer', goal: 'Read a module' });
    f.store.updateRun(child.id, { status: 'completed', resultRef: f.store.blob({ text: answer().message.content }) });
    f.app.coordinator.mailbox.onTerminal(child.id);
    expect(f.store.message(`terminal:${child.id}`)).toBeUndefined();
    expect(f.store.run(child.id).status).toBe('completed');
  });

  it('rejects continuations from another graph node', () => {
    const f = team();
    const child = f.app.coordinator.mailbox.spawnTaskHost(f.main.id, { runId: 'child', nodeId: 'one', generation: 1, role: 'explorer', goal: 'Read a module' });
    f.store.updateRun(child.id, { status: 'completed' });
    expect(() => f.app.coordinator.mailbox.spawnTaskHost(f.main.id, { runId: 'bad', nodeId: 'two', generation: 1, role: 'explorer', goal: 'Different task', continuation: { mode: 'resume', fromRunId: child.id } })).toThrow('its own settled child');
  });
});
