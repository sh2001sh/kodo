import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Application } from '../src/application/index.js';
import { childCapacity } from '../src/messaging/spawn-spec.js';
import { historyRuns } from '../src/runtime/history.js';
import { buildContext } from '../src/runtime/context.js';
import { todoMessage } from '../src/runtime/context-progress.js';
import { readTodoSnapshot } from '../src/tools/todo.js';
import type { Message, Provider } from '../src/runtime/types.js';
import { answer, call, calls, fixture, scripted } from './helpers.js';

function operation(app: Application, main: string, name: string, args: Record<string, unknown>, callId: string = crypto.randomUUID()) {
  const mailbox = app.coordinator.mailbox;
  const run = app.store.run(main);
  return mailbox.execute(run, callId, name, mailbox.validate(run, name, JSON.stringify(args))) as { id: string; agentId: string };
}
function spawn(app: Application, main: string) {
  return operation(app, main, 'spawn_agent', { objective: 'Inspect a bounded independent question', permissions: ['read'], scope: { write: [] } });
}
function finish(app: Application, id: string) {
  app.store.updateRun(id, { status: 'completed', resultRef: app.store.blob({ text: 'Recorded result', quality: { status: 'passed' } }) });
}

/** Isolated synthetic lifecycle records: no model, tool write or process is executed. */
function syntheticWrite(app: Application, runId: string, id: string, status: 'unknown' | 'running' = 'unknown') {
  app.store.putCall({ id, runId, step: 0, kind: 'tool', name: 'file.apply_patch', status, effect: 'write', effectState: 'started',
    requestRef: app.store.blob(call('file.apply_patch', { path: 'synthetic-not-executed.txt', expectedHash: null, content: 'synthetic fixture only' }, id)), reservedTokens: 0 });
  app.store.event(runId, 'tool.started', { callId: id });
  return app.store.call(id);
}

describe('reusable agents and active task capacity', () => {
  it('releases active slots after eight tasks finish and can create a ninth identity', () => {
    const { app, runId } = fixture();
    const children = Array.from({ length: 8 }, () => spawn(app, runId));
    expect(() => spawn(app, runId)).toThrow('active child limit');
    for (const child of children) finish(app, child.id);
    const next = spawn(app, runId);
    expect(children.every(child => child.agentId !== next.agentId)).toBe(true);
    expect(childCapacity(app.store, app.store.run(runId).sessionId)).toMatchObject({ maximum: null, maximumActive: 8, created: 9, active: 1, remaining: 7 });
  });

  it('retains an explicitly configured cumulative cap after completion, including follow-ups', () => {
    const { app, runId } = fixture();
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, maxChildren: 1 } });
    const child = spawn(app, runId);
    finish(app, child.id);
    expect(() => spawn(app, runId)).toThrow('creation limit');
    expect(() => operation(app, runId, 'followup_task', { target: child.agentId, objective: 'Clarify the result' })).toThrow('creation limit');
  });

  it('continues the same teammate with its working conversation and a separate task result', async () => {
    const { app, runId } = fixture(scripted(answer('The previous investigation found MARKER_731.')));
    const first = spawn(app, runId);
    await app.coordinator.wake(first.id);
    expect(app.store.run(first.id).status).toBe('completed');
    const source = app.store.run(first.id);
    const next = operation(app, runId, 'followup_task', { target: first.agentId, objective: 'Explain the previous finding in more detail.' });
    expect(next.id).not.toBe(first.id);
    expect(next.agentId).toBe(first.agentId);
    expect(app.store.run(next.id)).toMatchObject({ parentId: runId, continuationOf: first.id, historyFrom: first.id, status: 'queued', step: 0 });
    expect(app.store.run(next.id).resultRef).toBeUndefined();
    const context = app.store.readBlob<Message[]>(app.store.run(next.id).contextRef);
    expect(context.some(message => message.role === 'assistant' && message.content?.includes('MARKER_731'))).toBe(true);
    expect(context.at(-1)?.content).toContain('Explain the previous finding');
    expect(context[0]?.content).toContain(`Run ID: ${next.id}`);
    expect(app.store.run(first.id)).toEqual(source);
    expect(historyRuns(app.store, app.store.run(next.id)).map(run => run.id)).toContain(first.id);
    expect(() => operation(app, runId, 'followup_task', { target: first.id, objective: 'Another concurrent task' })).toThrow('unfinished work');
  });

  it('reuses the latest run, rejects concurrent branches and makes retries idempotent', () => {
    const { app, runId } = fixture();
    const first = spawn(app, runId);
    finish(app, first.id);
    const args = { target: first.agentId, objective: 'Follow-up one' };
    const second = operation(app, runId, 'followup_task', args, 'same-call');
    expect(operation(app, runId, 'followup_task', args, 'same-call')).toEqual(second);
    expect(() => operation(app, runId, 'followup_task', { ...args, objective: 'Different task' }, 'same-call')).toThrow('different task inputs');
    expect(() => operation(app, runId, 'spawn_agent', { objective: 'Concurrent continuation', continuation_of: first.id })).toThrow('unfinished work');
    finish(app, second.id);
    const third = operation(app, runId, 'followup_task', { target: first.id, objective: 'Follow-up two' });
    expect(app.store.run(third.id).continuationOf).toBe(second.id);
    expect(third.agentId).toBe(first.agentId);
  });

  it('starts a fresh task list while retaining the previous planning tool history', async () => {
    const { app, runId } = fixture(scripted(
      calls(call('todo.write', { expectedRevision: 0, items: [{ id: 'research', content: 'Read the module', status: 'completed' }] })),
      answer('The module investigation is complete.'),
    ));
    const first = spawn(app, runId);
    await app.coordinator.wake(first.id);
    const source = app.store.run(first.id);
    const marker = todoMessage(readTodoSnapshot(app.store, source.id));
    // Persist the runtime planning snapshot as it can appear in retained context.
    app.store.updateRun(source.id, { contextRef: app.store.blob([...app.store.readBlob<Message[]>(source.contextRef), marker]) });
    const next = operation(app, runId, 'followup_task', { target: first.agentId, objective: 'Investigate a related question' });
    expect(readTodoSnapshot(app.store, next.id)).toEqual({ ownerRunId: next.id, revision: 0, items: [] });
    const context = buildContext(app.store, app.store.run(next.id), 16_000, []).messages;
    expect(context.some(message => message.content === marker.content)).toBe(false);
    expect(context.some(message => message.role === 'assistant' && message.tool_calls?.some(tool => tool.name === 'todo.write'))).toBe(true);
    expect(context.some(message => message.content?.includes('This run starts with an empty task list'))).toBe(true);
  });

  it('refreshes nested instructions discovered by a teammate when factors are off', async () => {
    const { app, root, runId } = fixture(scripted(calls(call('file.read', { path: 'nested/module.txt' })), answer('Read the module.')),
      undefined, { agentFactors: { A: false, B: false, C: false }, instructions: { global: false } });
    mkdirSync(path.join(root, 'nested'));
    writeFileSync(path.join(root, 'nested', 'AGENTS.md'), 'Describe module results with NESTED_METHOD_ONE.');
    writeFileSync(path.join(root, 'nested', 'module.txt'), 'Example module');
    const first = spawn(app, runId);
    await app.coordinator.wake(first.id);
    expect(app.store.run(first.id).status).toBe('completed');
    writeFileSync(path.join(root, 'nested', 'AGENTS.md'), 'Describe module results with NESTED_METHOD_TWO.');
    const next = operation(app, runId, 'followup_task', { target: first.agentId, objective: 'Explain the module' });
    const context = app.store.readBlob<Message[]>(app.store.run(next.id).contextRef);
    expect(context.some(message => message.role === 'user' && message.content.includes('NESTED_METHOD_TWO'))).toBe(true);
  });

  it('keeps cancellation and unsettled work counted until settlement', () => {
    const { app, runId } = fixture();
    const child = spawn(app, runId);
    app.store.updateRun(child.id, { cancelRequested: true });
    expect(childCapacity(app.store, app.store.run(runId).sessionId).active).toBe(1);
    // Isolated synthetic pending read: no process or workspace side effect is executed.
    app.store.putCall({ id: 'pending-read', runId: child.id, step: 0, kind: 'tool', name: 'file.read', status: 'running', effect: 'read', requestRef: app.store.blob({}), reservedTokens: 0 });
    app.store.updateRun(child.id, { status: 'cancelled' });
    expect(childCapacity(app.store, app.store.run(runId).sessionId).active).toBe(1);
    expect(() => operation(app, runId, 'followup_task', { target: child.id, objective: 'Continue' })).toThrow('unfinished work');
    app.store.putCall({ ...app.store.call('pending-read'), status: 'cancelled' });
    expect(childCapacity(app.store, app.store.run(runId).sessionId).active).toBe(0);
  });

  it.each((['unknown', 'running'] as const).flatMap(status => [
    { status, outcome: 'succeeded' as const, retry: false },
    { status, outcome: 'failed' as const, retry: false },
    { status, outcome: 'not_applied' as const, retry: false },
    { status, outcome: 'not_applied' as const, retry: true },
  ]))('settles a synthetic cancelled $status write as $outcome (retry=$retry) before admitting new work', ({ status, outcome, retry }) => {
    const { app, runId } = fixture(scripted());
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, maxActiveChildren: 1 } });
    const child = operation(app, runId, 'spawn_agent', { objective: 'Synthetic lifecycle fixture; do not execute' });
    const originalCall = syntheticWrite(app, child.id, 'synthetic-write', status);
    app.store.updateRun(child.id, { status: 'cancelled', cancelRequested: true });
    const originalRun = app.store.run(child.id);
    const member = () => {
      const list = app.coordinator.mailbox.execute(app.store.run(runId), 'synthetic-list', 'list_agents', {}) as { members: { agentId: string; runId: string; available: boolean }[] };
      return list.members.find(item => item.agentId === child.agentId);
    };
    expect(member()).toMatchObject({ runId: child.id, available: false });
    expect(() => spawn(app, runId)).toThrow('active child limit');
    expect(() => operation(app, runId, 'followup_task', { target: child.agentId, objective: 'A separate follow-up task' })).toThrow('unfinished work');

    const plan = app.resolveCall(child.id, originalCall.id, { outcome, retry, evidence: `Isolated synthetic fixture: recorded ${outcome}; no tool or filesystem effect was executed.` });
    expect(plan.calls[0]?.status).toBe(outcome === 'not_applied' ? retry ? 'planned' : 'cancelled' : outcome);
    expect(app.store.call(originalCall.id)).toEqual(originalCall);
    expect(app.store.run(child.id)).toEqual(originalRun);
    expect(childCapacity(app.store, session.id)).toMatchObject({ active: 0, remainingActive: 1 });
    expect(member()).toMatchObject({ runId: child.id, available: true });

    const fresh = spawn(app, runId);
    expect(childCapacity(app.store, session.id).activeRunIds).toEqual([fresh.id]);
    finish(app, fresh.id);
    const next = operation(app, runId, 'followup_task', { target: child.agentId, objective: 'A separate follow-up task' });
    expect(next.agentId).toBe(child.agentId);
    expect(next.id).not.toBe(child.id);
    expect(childCapacity(app.store, session.id)).toMatchObject({ created: 3, active: 1, activeRunIds: [next.id] });
    expect(member()).toMatchObject({ runId: next.id, available: false });
    expect(app.store.call(originalCall.id)).toEqual(originalCall);
  });

  it('keeps a synthetic terminal child occupied until every uncertain write is settled', () => {
    const { app, runId } = fixture(scripted());
    const child = operation(app, runId, 'spawn_agent', { objective: 'Synthetic partial-settlement fixture' });
    const first = syntheticWrite(app, child.id, 'synthetic-first');
    const second = syntheticWrite(app, child.id, 'synthetic-second', 'running');
    app.store.updateRun(child.id, { status: 'cancelled' });
    const sessionId = app.store.run(runId).sessionId;
    const partial = app.resolveCall(child.id, first.id, { outcome: 'succeeded', evidence: 'Synthetic first call has a definite outcome; no tool was executed.' });
    expect(partial.blocked).toEqual([second.id]);
    expect(childCapacity(app.store, sessionId).active).toBe(1);
    expect(() => operation(app, runId, 'followup_task', { target: child.id, objective: 'Wait for settlement' })).toThrow('unfinished work');
    app.resolveCall(child.id, second.id, { outcome: 'failed', evidence: 'Synthetic second call has a definite outcome; no tool was executed.' });
    expect(childCapacity(app.store, sessionId).active).toBe(0);
    expect(app.store.call(first.id)).toEqual(first);
    expect(app.store.call(second.id)).toEqual(second);
  });

  it('does not apply an older synthetic settlement to a later attempt of the same call', () => {
    const { app, runId } = fixture(scripted());
    const child = operation(app, runId, 'spawn_agent', { objective: 'Synthetic attempt-boundary fixture' });
    const original = syntheticWrite(app, child.id, 'synthetic-attempt');
    app.store.updateRun(child.id, { status: 'cancelled' });
    app.resolveCall(child.id, original.id, { outcome: 'succeeded', evidence: 'Synthetic first attempt was settled; no operation was executed.' });
    const sessionId = app.store.run(runId).sessionId;
    expect(childCapacity(app.store, sessionId).active).toBe(0);
    // Only append synthetic lifecycle history; this does not execute or retry a tool.
    app.store.event(child.id, 'tool.started', { callId: original.id, synthetic: true });
    expect(app.coordinator.recovery.plan(child.id).blocked).toEqual([original.id]);
    expect(childCapacity(app.store, sessionId).active).toBe(1);
    expect(() => operation(app, runId, 'followup_task', { target: child.id, objective: 'A later task' })).toThrow('unfinished work');
    app.resolveCall(child.id, original.id, { outcome: 'failed', evidence: 'Synthetic later attempt was separately settled; no operation was executed.' });
    expect(app.coordinator.recovery.plan(child.id).blocked).toEqual([]);
    expect(childCapacity(app.store, sessionId).active).toBe(0);
    expect(app.store.call(original.id)).toEqual(original);
  });

  it.each([
    { status: 'planned' as const, effect: 'read' as const },
    { status: 'planned' as const, effect: 'write' as const },
    { status: 'running' as const, effect: 'read' as const },
  ])('keeps synthetic $status $effect work occupied after another write is settled', ({ status, effect }) => {
    const { app, runId } = fixture(scripted());
    const child = operation(app, runId, 'spawn_agent', { objective: 'Synthetic pending-work fixture' });
    const settled = syntheticWrite(app, child.id, 'synthetic-settled');
    app.store.putCall({ id: 'synthetic-pending', runId: child.id, step: 0, kind: 'tool', name: effect === 'read' ? 'file.read' : 'file.apply_patch', status, effect,
      requestRef: app.store.blob({ synthetic: true }), reservedTokens: 0 });
    app.store.updateRun(child.id, { status: 'cancelled' });
    app.resolveCall(child.id, settled.id, { outcome: 'succeeded', evidence: 'Synthetic settled call has no actual effect; another call is pending.' });
    expect(childCapacity(app.store, app.store.run(runId).sessionId).active).toBe(1);
    expect(() => operation(app, runId, 'followup_task', { target: child.id, objective: 'Wait for pending work' })).toThrow('unfinished work');
  });

  it('keeps a synthetic interrupted child occupied after its write is settled', () => {
    const { app, runId } = fixture(scripted());
    const child = operation(app, runId, 'spawn_agent', { objective: 'Synthetic interrupted-run fixture' });
    const pending = syntheticWrite(app, child.id, 'synthetic-interrupted');
    app.store.updateRun(child.id, { status: 'interrupted' });
    app.resolveCall(child.id, pending.id, { outcome: 'succeeded', evidence: 'Synthetic effect is settled but the interrupted task is unfinished.' });
    expect(app.store.call(pending.id).status).toBe('succeeded');
    expect(childCapacity(app.store, app.store.run(runId).sessionId).active).toBe(1);
  });

  it('retains synthetic settlement and retry eligibility when the store is reopened', async () => {
    const { app, root, runId } = fixture(scripted());
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, maxActiveChildren: 1 } });
    const child = operation(app, runId, 'spawn_agent', { objective: 'Synthetic persistence fixture' });
    const originalCall = syntheticWrite(app, child.id, 'synthetic-persisted');
    app.store.updateRun(child.id, { status: 'cancelled' });
    const originalRun = app.store.run(child.id);
    app.resolveCall(child.id, originalCall.id, { outcome: 'not_applied', retry: true, evidence: 'Synthetic fixture has no actual effect; retry eligibility is metadata only.' });
    await app.shutdown();
    const restored = new Application(path.join(root, '.state'), scripted(), undefined, { agentFactors: { D: false, E: false, B: false } });
    try {
      expect(restored.store.call(originalCall.id)).toEqual(originalCall);
      expect(restored.store.run(child.id)).toEqual(originalRun);
      expect(restored.coordinator.recovery.plan(child.id).calls[0]?.status).toBe('planned');
      expect(childCapacity(restored.store, session.id).active).toBe(0);
      const next = operation(restored, runId, 'followup_task', { target: child.agentId, objective: 'A distinct task after reopening storage' });
      expect(next.agentId).toBe(child.agentId);
      expect(childCapacity(restored.store, session.id).activeRunIds).toEqual([next.id]);
    } finally { await restored.shutdown(); }
  });

  it('validates the entire explore batch against remaining active capacity', () => {
    const { app, runId } = fixture();
    for (let i = 0; i < 7; i++) spawn(app, runId);
    expect(() => operation(app, runId, 'explore', { tasks: [{ prompt: 'Question one' }, { prompt: 'Question two' }] })).toThrow('only 1 child slots');
    expect(app.store.listRuns(app.store.run(runId).sessionId).filter(run => run.parentId)).toHaveLength(7);
  });

  it('requires fresh task input and preserves the previous card contract without partial creation', () => {
    const { app, runId } = fixture();
    const child = operation(app, runId, 'spawn_agent', { objective: 'Locate a symbol' });
    finish(app, child.id);
    expect(() => operation(app, runId, 'followup_task', { target: child.id, objective: 'Find its caller', agent: 'kodo/explorer' })).toThrow();
    expect(app.store.listRuns(app.store.run(runId).sessionId)).toHaveLength(2);
    const next = operation(app, runId, 'followup_task', { target: child.id, objective: 'Find its caller' });
    expect(app.store.run(next.id).card.digest).toBe(app.store.run(child.id).card.digest);
    expect(app.store.latestEvent(next.id, { types: ['report.submitted'] })).toBeUndefined();
  });

  it('restores the agent identity after restart and permits management by a main follow-up', async () => {
    const { app, root, runId } = fixture();
    const child = spawn(app, runId);
    finish(app, child.id);
    finish(app, runId);
    const main = app.submitInput(runId, 'A related follow-up request');
    await app.shutdown();
    const restored = new Application(path.join(root, '.state'), scripted(answer()), undefined, { agentFactors: { D: false, E: false, B: false } });
    try {
      const next = operation(restored, main.id, 'followup_task', { target: child.id, objective: 'Continue the same investigation' });
      expect(next.agentId).toBe(child.agentId);
      expect(restored.store.run(next.id).parentId).toBe(main.id);
      expect(historyRuns(restored.store, restored.store.run(next.id)).map(run => run.id)).toContain(child.id);
      const list = restored.coordinator.mailbox.execute(restored.store.run(main.id), 'list', 'list_agents', {}) as { members: { agentId: string; runId: string; available: boolean }[] };
      expect(list.members).toEqual([expect.objectContaining({ agentId: child.agentId, runId: next.id, available: false })]);
    } finally { await restored.shutdown(); }
  });

  it('runs planning, dispatch and follow-up through normal model tool calls', async () => {
    let agentId = '';
    let lastRun = '';
    const seen: string[] = [];
    const provider: Provider = { async complete(request) {
      const id = /Run ID: ([^. ]+)\./u.exec(request.messages[0]!.content!)![1]!;
      const run = app.store.run(id);
      if (run.parentId) {
        if (run.continuationOf) expect(request.messages.some(message => message.role === 'assistant' && message.content === 'FIRST_TASK_EVIDENCE')).toBe(true);
        return answer(run.continuationOf ? 'FOLLOWUP_EVIDENCE' : 'FIRST_TASK_EVIDENCE');
      }
      seen.push(String(run.step));
      if (run.step === 0) return calls(call('todo.write', { expectedRevision: 0, items: [{ id: 'investigate', content: 'Investigate and clarify the result', status: 'in_progress', executor: 'agent' }] }));
      if (run.step === 1) return calls(call('spawn_agent', { objective: 'Investigate the independent question', permissions: ['read'], scope: { write: [] } }));
      if (run.step === 2) {
        const child = app.store.listRuns(run.sessionId).find(child => child.parentId)!;
        agentId = child.agentId!; lastRun = child.id;
        return calls(call('wait_for_events', { run_ids: [lastRun], mode: 'all' }));
      }
      if (run.step === 3) return calls(call('followup_task', { target: agentId, objective: 'Clarify the evidence' }));
      if (run.step === 4) {
        lastRun = app.store.listRuns(run.sessionId).find(child => child.parentId && child.continuationOf)!.id;
        return calls(call('wait_for_events', { run_ids: [lastRun], mode: 'all' }));
      }
      if (run.step === 5) return calls(call('todo.write', { expectedRevision: 1, items: [{ id: 'investigate', content: 'Investigate and clarify the result', status: 'completed', executor: 'agent' }] }));
      return answer('Integrated the two task results.');
    } };
    const { app, runId } = fixture(provider, undefined, { agentFactors: { B: true } });
    expect(app.store.session(app.store.run(runId).sessionId).agentFactors?.B).toBe(true);
    const main = await app.run(runId);
    expect(main.status).toBe('completed');
    expect(seen).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    const children = app.store.listRuns(main.sessionId).filter(run => run.parentId);
    expect(children).toHaveLength(2);
    expect(new Set(children.map(run => run.agentId)).size).toBe(1);
    expect(children.every(run => run.status === 'completed')).toBe(true);
    expect(readTodoSnapshot(app.store, runId).items).toEqual([
      { id: 'investigate', content: 'Investigate and clarify the result', status: 'completed', executor: 'agent' },
    ]);
  });
});
