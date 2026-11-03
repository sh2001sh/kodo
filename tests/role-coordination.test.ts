import { describe, expect, it } from 'vitest';
import { Application } from '../src/application/index.js';
import { toolSpecs } from '../src/runtime/step-host.js';
import type { Message, ToolSpec } from '../src/runtime/types.js';
import { answer, call, calls, fixture, scripted } from './helpers.js';

describe('lead coordination with delegated execution tools', () => {
  it('persists an E-enabled user wait and resumes with saved factors after reopening with different defaults', async () => {
    let originalTools: ToolSpec[] = [];
    const { app, runId } = fixture(scripted(async request => {
      originalTools = request.tools;
      expect(request.tools.map(tool => tool.name)).toContain('ask_user');
      expect(request.tools.map(tool => tool.name)).not.toContain('shell.exec');
      return calls(call('ask_user', { question: 'Which release should be reviewed?' }, 'ask-release'));
    }), ['read', 'write', 'exec'], { instructions: { global: false }, agentFactors: { D: true, E: true } });
    expect((await app.run(runId)).status).toBe('waiting');
    const run = app.store.run(runId);
    const factors = app.store.session(run.sessionId).agentFactors;
    const question = app.coordinator.mailbox.userQuestions(run.sessionId)[0]!;
    const wait = app.store.wait(run.waitId!);
    expect(wait).toMatchObject({ status: 'registered', questionIds: [question.id] });
    expect(app.store.readBlob<Message[]>(run.contextRef).at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'ask-release' });
    const directory = app.store.directory;
    await app.shutdown();

    let resumedCalls = 0;
    const reopened = new Application(directory, scripted(async request => {
      resumedCalls++;
      expect(request.tools).toEqual(originalTools);
      expect(JSON.stringify(request.messages)).toContain('release-9');
      expect(request.messages.filter(message => message.role === 'tool' && message.tool_call_id === 'ask-release')).toHaveLength(1);
      return calls(call('recovery.inspect', {}, 'inspect-effects'));
    }, async request => {
      expect(request.tools).toEqual(originalTools);
      return answer('release-9 confirmed; no effects need recovery.');
    }), undefined, { instructions: { global: false }, agentFactors: { D: false, E: false } });
    try {
      expect(reopened.store.session(run.sessionId).agentFactors).toEqual(factors);
      expect(reopened.store.session(run.sessionId).agentFactors).toMatchObject({ D: true, E: true });
      expect((await reopened.run(runId)).status).toBe('waiting');
      expect(resumedCalls).toBe(0);
      expect(reopened.store.wait(wait.id)).toEqual(wait);
      reopened.answer(question.id, 'release-9');
      const completed = await reopened.run(runId);
      expect(completed.status, completed.error).toBe('completed');
      expect(reopened.coordinator.mailbox.userQuestions(run.sessionId)).toEqual([]);
      const inspection = reopened.store.calls(runId).find(item => item.name === 'recovery.inspect')!;
      expect(inspection.status).toBe('succeeded');
      expect(reopened.store.readBlob(inspection.resultRef!)).toMatchObject({ sourceRunId: runId, blocked: [], observations: [] });
    } finally { await reopened.shutdown(); }
  });

  it('keeps every coordination definition unchanged when E changes on the same frozen session', () => {
    const { app, runId } = fixture(undefined, ['read', 'write', 'exec'], { instructions: { global: false }, agentFactors: { E: false } });
    const run = app.store.run(runId);
    const session = app.store.session(run.sessionId);
    const ordinaryCoordination = app.coordinator.mailbox.specs(run);
    const ordinaryTools = toolSpecs(app.coordinator, run, session);
    const delegated = { ...session, agentFactors: { ...session.agentFactors, E: true } };
    app.store.putSession(delegated);
    expect(app.coordinator.mailbox.specs(run)).toEqual(ordinaryCoordination);
    const delegatedTools = toolSpecs(app.coordinator, run, delegated);
    for (const spec of ordinaryCoordination) expect(delegatedTools.find(tool => tool.name === spec.name)).toEqual(spec);
    const names = delegatedTools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining(['ask_user', 'wait_for_events', 'inspect_run', 'cancel_agent', 'spawn_agent', 'update_progress', 'recovery.inspect', 'file.read', 'artifact.write']));
    expect(ordinaryTools.map(tool => tool.name)).toContain('shell.exec');
    expect(names).not.toContain('shell.exec');
  });

  it('still validates and executes child inspection, cancellation, event waiting and native recovery', async () => {
    const { app, runId } = fixture(undefined, ['read', 'write', 'exec'], { instructions: { global: false }, agentFactors: { E: true } });
    const run = app.store.run(runId);
    const invoke = (name: string, args: Record<string, unknown>) => {
      const validated = app.coordinator.mailbox.validate(run, name, JSON.stringify(args));
      return app.store.transaction(() => app.coordinator.mailbox.execute(run, `role-coordination:${name}`, name, validated));
    };
    const child = invoke('spawn_agent', { objective: 'Read the supplied entry point.', scope: { read: ['.'], write: [] } }) as { id: string };
    expect(invoke('inspect_run', { run_id: child.id })).toMatchObject({ runId: child.id, status: 'queued' });
    expect(invoke('cancel_agent', { run_id: child.id })).toMatchObject({ id: child.id, status: 'cancelled', cancelRequested: true });
    const registered = invoke('wait_for_events', { run_ids: [child.id], mode: 'all' }) as { waitId: string };
    expect(app.store.wait(registered.waitId)).toMatchObject({ status: 'settled', reason: 'conditions_met', runIds: [child.id] });
    const recovery = await app.coordinator.tools.execute(runId, 'recovery.inspect', {}, new AbortController().signal);
    expect(recovery).toMatchObject({ sourceRunId: runId, blocked: [], observations: [] });
    expect((await app.run(runId)).status).toBe('completed');
  });
});
