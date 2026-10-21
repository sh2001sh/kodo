import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import type { Message, Provider, Run } from '../src/runtime/types.js';
import { answer, binding, call, calls, fixture, scripted } from './helpers.js';

function internal(app: Application, run: Run, name: string, args: Record<string, unknown>): unknown {
  return app.store.transaction(() => app.coordinator.mailbox.execute(run, `${name}:${app.store.messages(run.sessionId).length}`, name, args));
}

describe('input, decisions and durable lifecycle', () => {
  it('persists ask_user and resumes after reopening with complete tool history', async () => {
    const { app, runId } = fixture(scripted(calls(call('ask_user', { question: 'Which release?' }, 'ask'))));
    expect((await app.run(runId)).status).toBe('waiting');
    const question = app.coordinator.mailbox.userQuestions(app.store.run(runId).sessionId)[0]!;
    const context = app.store.readBlob<Message[]>(app.store.run(runId).contextRef);
    expect(context.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'ask' });
    const directory = app.store.directory;
    app.close();
    const reopened = new Application(directory, scripted(async request => {
      expect(JSON.stringify(request.messages)).toContain('release-9');
      expect(request.messages.filter(x => x.role === 'tool' && x.tool_call_id === 'ask')).toHaveLength(1);
      return answer('release-9 confirmed');
    }));
    try {
      reopened.answer(question.id, 'release-9');
      expect(() => reopened.answer(question.id, 'release-10')).toThrow('different answer');
      expect((await reopened.run(runId)).status).toBe('completed');
      expect(reopened.coordinator.mailbox.userQuestions(question.sessionId)).toHaveLength(0);
    } finally { await reopened.shutdown(); }
  });

  it('processes steer input arriving during final response rather than losing it', async () => {
    const provider = scripted(async () => {
      app.submitInput(runId, 'Also include the rollback evidence.');
      return answer('first result');
    }, async request => {
      expect(JSON.stringify(request.messages)).toContain('rollback evidence');
      return answer('result including rollback evidence');
    });
    const { app, runId } = fixture(provider);
    const result = await app.run(runId);
    expect(app.store.readBlob<{ text: string }>(result.resultRef!).text).toContain('rollback');
    expect(app.store.events(runId).filter(x => x.type === 'run.completion_deferred')).toHaveLength(1);
  });

  it('creates immutable continuations for terminal inputs and queued follow-ups', async () => {
    const { app, runId } = fixture(scripted(answer('original'), answer('follow-up')));
    const next = app.submitInput(runId, 'next task', { mode: 'follow_up' });
    expect(app.store.run(runId).status).toBe('queued');
    await app.run(runId);
    const previous = app.store.run(runId);
    expect((await app.run(next.id)).status).toBe('completed');
    expect(next.continuationOf).toBe(runId);
    expect(app.store.run(runId)).toEqual(previous);
    const later = app.submitInput(runId, 'new task after terminal');
    expect(later.id).not.toBe(runId);
    expect(later.continuationOf).toBe(runId);
    expect(app.store.run(runId)).toEqual(previous);
  });

  it('rejects every unstarted action from a response made before a new decision', async () => {
    const { app, runId } = fixture(scripted(async () => {
      app.submitInput(runId, 'Do not edit any files.', { decision: true });
      return calls(call('file.apply_patch', { path: 'obsolete.txt', expectedHash: null, content: 'obsolete' }));
    }, async request => {
      expect(JSON.stringify(request.messages)).toContain('DECISION_CHANGED');
      expect(JSON.stringify(request.messages)).toContain('Do not edit any files');
      return answer('respected the changed constraint');
    }));
    expect((await app.run(runId)).status).toBe('completed');
    expect(existsSync(path.join(app.store.session(app.store.run(runId).sessionId).workspace, 'obsolete.txt'))).toBe(false);
    expect(app.store.decisions(app.store.run(runId).sessionId)).toEqual([{ version: 1, content: 'Do not edit any files.' }]);
  });

  it('blocks changed decisions after tool.started but before internal effects', async () => {
    const { app, runId } = fixture(scripted(calls(call('spawn_agent', { objective: 'obsolete task' })), answer()));
    let injected = false;
    app.store.subscribe(event => {
      if (event.type === 'tool.started' && !injected) { injected = true; app.submitInput(runId, 'Do the work alone.', { decision: true }); }
    });
    expect((await app.run(runId)).status).toBe('completed');
    expect(app.store.listRuns()).toHaveLength(1);
    expect(app.store.calls(runId).find(x => x.name === 'spawn_agent')?.status).toBe('failed');
  });

  it('marks completed old decision results stale without changing their terminal records', async () => {
    const { app, runId } = fixture(scripted(answer('old evidence')));
    const main = app.store.run(runId);
    const child = internal(app, main, 'spawn_agent', { objective: 'child evidence' }) as { id: string };
    await app.coordinator.wake(child.id);
    const original = app.store.run(child.id);
    app.submitInput(runId, 'Use a different acceptance criterion.', { decision: true });
    const snapshot = app.snapshot(runId) as { runs: (Run & { stale: boolean })[] };
    expect(snapshot.runs.find(x => x.id === child.id)?.stale).toBe(true);
    expect(app.store.run(child.id)).toEqual(original);
  });

  it('revokes permissions and disallows runtime escalation', async () => {
    const { app, runId } = fixture();
    const main = app.store.run(runId);
    const child = internal(app, main, 'spawn_agent', { objective: 'read-only child', permissions: ['read'] }) as { id: string };
    app.updatePermissions(runId, ['read']);
    expect(() => app.updatePermissions(runId, ['read', 'write'])).toThrow('revoke');
    const childRun = app.store.run(child.id);
    await expect(app.coordinator.tools.execute(child.id, 'file.apply_patch', { path: 'denied.txt', expectedHash: null, content: 'x' }, new AbortController().signal)).rejects.toThrow('not authorized');
    expect(app.store.session(childRun.sessionId).permissions).toEqual(['read']);
    expect(app.store.inbox(child.id).some(x => x.kind === 'decision')).toBe(true);
  });

  it('recovers an internal running call safely after process reopen', async () => {
    const { app, runId } = fixture();
    const response = calls(call('spawn_agent', { objective: 'recover child exactly once' }, 'spawn'));
    const modelId = 'internal-crash-model';
    app.store.putCall({ id: modelId, runId, step: 0, kind: 'model', name: 'test', status: 'succeeded', effect: 'read', requestRef: app.store.blob({}), resultRef: app.store.blob(response), reservedTokens: 0 });
    app.store.putCall({ id: `${modelId}:spawn`, runId, step: 0, kind: 'tool', name: 'spawn_agent', status: 'running', effect: 'write', requestRef: app.store.blob(response.message.tool_calls![0]), reservedTokens: 0 });
    app.store.updateRun(runId, { status: 'running', stepCallId: modelId });
    const directory = app.store.directory;
    app.close();
    const reopened = new Application(directory, scripted(answer('recovered')));
    try {
      expect((await reopened.coordinator.resume(runId)).status).toBe('completed');
      expect(reopened.store.listRuns().filter(x => x.parentId === runId)).toHaveLength(1);
      expect(reopened.store.call(`${modelId}:spawn`).status).toBe('succeeded');
    } finally { await reopened.shutdown(); }
  });

  it('shares artifacts inside a session while rejecting another session', () => {
    const { app, root, runId } = fixture();
    const run = app.store.run(runId);
    const child = internal(app, run, 'spawn_agent', { objective: 'evidence' }) as { id: string };
    const artifact = app.store.artifact(child.id, app.store.blob({ content: 'child proof' }));
    expect(app.store.readArtifact(run.id, artifact)).toMatchObject({ content: 'child proof', provenance: { runId: child.id, decisionVersion: 0, stale: false } });
    app.submitInput(run.id, 'Recheck evidence against changed criteria.', { decision: true });
    expect(app.store.readArtifact(run.id, artifact)).toMatchObject({ provenance: { decisionVersion: 0, stale: true } });
    const other = app.createRun({ objective: 'other', workspace: root, binding });
    expect(() => app.store.readArtifact(other.id, artifact)).toThrow('this session');
  });
  it('does not expose the main task packet through child agent discovery', () => {
    const { app, runId } = fixture();
    app.store.updateRun(runId, { objective: 'PRIVATE_MAIN_ONLY_TASK_PACKET' });
    const main = app.store.run(runId);
    const child = internal(app, main, 'spawn_agent', { objective: 'minimal assigned task' }) as { id: string };
    const discovery = internal(app, app.store.run(child.id), 'list_agents', {});
    expect(JSON.stringify(discovery)).not.toContain('PRIVATE_MAIN_ONLY_TASK_PACKET');
    expect(JSON.stringify(app.store.readBlob(app.store.run(child.id).contextRef))).not.toContain('PRIVATE_MAIN_ONLY_TASK_PACKET');
  });

  it('keeps main response capacity when children exhaust their available call budget', async () => {
    let count = 0;
    const complete: Provider['complete'] = async request => {
      count++;
      const identity = request.messages[0]!.content!;
      return identity.includes('You are a child.') ? calls(call('file.list', { path: '.' }, `list-${count}`)) : answer('main can still respond');
    };
    const { app, runId } = fixture({ complete });
    const main = app.store.run(runId);
    const session = app.store.session(main.sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, maxModelCalls: 3, maxTokens: 200_000 } });
    const child = internal(app, main, 'spawn_agent', { objective: 'bounded child' }) as { id: string };
    const childResult = await app.coordinator.wake(child.id);
    expect(childResult.error).toContain('CHILD_BUDGET');
    expect(app.store.session(main.sessionId).modelCalls).toBe(2);
    expect((await app.run(runId)).status).toBe('completed');
    expect(count).toBe(3);
  });

  it('does not reopen a cancelled run when a peer finishes late', async () => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const complete = vi.fn(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); return answer('late'); });
    const { app, runId } = fixture({ complete });
    const child = internal(app, app.store.run(runId), 'spawn_agent', { objective: 'late child' }) as { id: string };
    const pending = app.coordinator.wake(child.id);
    await entered;
    app.coordinator.cancel(runId);
    const cancelled = app.store.run(runId);
    release();
    await pending;
    expect(app.store.run(runId)).toEqual(cancelled);
    expect(app.store.run(child.id).status).toBe('cancelled');
  });
  it('stops a driver holding a durable wait before closing the database', async () => {
    const { app, runId } = fixture();
    const main = app.store.run(runId);
    const peer = internal(app, main, 'spawn_agent', { objective: 'waiting peer' }) as { id: string };
    app.store.updateRun(peer.id, { status: 'waiting' });
    internal(app, main, 'wait_for_events', { run_ids: [peer.id], timeout_ms: 300_000 });
    app.store.updateRun(runId, { status: 'waiting' });
    const driver = app.run(runId);
    expect(() => app.close()).toThrow('shutdown');
    await app.shutdown();
    expect((await driver).status).toBe('cancelled');
  });
  it('does not reset the persisted execution time budget when starting a child', async () => {
    const complete = vi.fn(async () => answer());
    const { app, runId } = fixture({ complete });
    const main = app.store.run(runId);
    const child = internal(app, main, 'spawn_agent', { objective: 'must share elapsed execution time' }) as { id: string };
    const session = app.store.session(main.sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, maxDurationMs: 1000 }, activeMs: 1000 });
    const result = await app.coordinator.wake(child.id);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('TIME_BUDGET');
    expect(complete).not.toHaveBeenCalled();
  });
});
