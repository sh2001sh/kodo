import { describe, expect, it } from 'vitest';
import { buildContext, followUpContext, updateTaskProgress } from '../src/runtime/context.js';
import { historyRuns, readHistory, recoveryHistoryRuns } from '../src/runtime/history.js';
import { inspectRun } from '../src/runtime/inspection.js';
import type { Message, Run } from '../src/runtime/types.js';
import { answer, binding, fixture, scripted } from './helpers.js';

describe('ordinary task continuity', () => {
  function followUp(source: Run, app: ReturnType<typeof fixture>['app'], id: string, objective = 'Continue with the next task'): Run {
    const next: Run = { ...source, id, objective, historyFrom: source.id, continuationOf: source.id, status: 'queued', step: 0, resultRef: undefined };
    next.contextRef = app.store.blob(followUpContext(app.store, source, next));
    app.store.putRun(next);
    return next;
  }

  it('regenerates host identity, retains exact prior constraints and bounds repeated prior evidence', () => {
    const { app, runId } = fixture();
    const source = app.store.run(runId);
    const messages = app.store.readBlob<Message[]>(source.contextRef);
    const initialChars = JSON.stringify(messages).length;
    messages.push({ role: 'user', content: 'Never modify vendor code; preserve the public API exactly.' });
    app.store.updateRun(runId, { contextRef: app.store.blob(messages), resultRef: app.store.blob({ text: 'Historic result '.repeat(5000) }) });
    let next = followUp(app.store.run(runId), app, 'follow-up-one');
    const first = app.store.readBlob<Message[]>(next.contextRef);
    expect(first[0]!.content).toContain('Run ID: follow-up-one.');
    expect(first.some(message => message.role === 'user' && message.content === source.objective)).toBe(true);
    expect(first.some(message => message.role === 'user' && message.content === 'Never modify vendor code; preserve the public API exactly.')).toBe(true);
    expect(first.at(-1)!.content).toBe(next.objective);
    expect(JSON.stringify(first).length - initialChars).toBeLessThan(3500);
    for (let index = 0; index < 12; index++) next = followUp(next, app, `follow-up-${index + 2}`);
    const repeated = app.store.readBlob<Message[]>(next.contextRef);
    expect(repeated.filter(message => message.content?.startsWith('Previous task evidence'))).toHaveLength(1);
    expect(JSON.stringify(repeated).length - initialChars).toBeLessThan(3500);
  });

  it('refreshes a queued follow-up with the final predecessor result and newest progress at execution', async () => {
    let checked = false;
    const fixtureState = fixture(scripted(async () => {
      updateTaskProgress(fixtureState.app.store, fixtureState.runId, { completed: ['Final predecessor work finished'], pending: ['Check the next task'] });
      return answer('FINAL PREDECESSOR OUTCOME');
    }, async request => {
      const text = JSON.stringify(request.messages);
      expect(text).toContain('FINAL PREDECESSOR OUTCOME');
      expect(text).toContain('Final predecessor work finished');
      expect(text).toContain('Do not change the external API');
      expect(text).toContain('Completed next task');
      checked = true;
      return answer('Next task delivered');
    }));
    const { app, runId } = fixtureState;
    app.submitInput(runId, 'Do not change the external API');
    const next = app.submitInput(runId, 'Completed next task', { mode: 'follow_up' });
    expect(app.store.run(runId).status).toBe('queued');
    expect(JSON.stringify(app.store.readBlob(next.contextRef))).not.toContain('FINAL PREDECESSOR OUTCOME');
    await app.run(runId);
    expect((await app.run(next.id)).status).toBe('completed');
    expect(checked).toBe(true);
  });

  it('retains original user constraints after a failed task without inheriting recovery validation', () => {
    const { app, runId } = fixture();
    app.submitInput(runId, 'Keep the database schema unchanged');
    app.store.updateRun(runId, { status: 'failed', error: 'provider unavailable', requiresValidation: true });
    const next = app.submitInput(runId, 'Continue the investigation');
    const built = buildContext(app.store, next, 16_000, []);
    const text = JSON.stringify(built.messages);
    expect(text).toContain('Keep the database schema unchanged');
    expect(text).toContain('Inspect the project and provide evidence.');
    expect(built.messages.find(message => message.content?.startsWith('Previous task evidence'))?.content).toContain('"status":"failed"');
    expect(next.requiresValidation).toBeUndefined();
    expect(recoveryHistoryRuns(app.store, next).map(run => run.id)).toEqual([next.id]);
  });

  it('grants prior managed child evidence and archives, without child or cross-session access', () => {
    const { app, runId, root } = fixture();
    const source = app.store.run(runId);
    const child = app.store.transaction(() => app.coordinator.mailbox.execute(source, 'spawn', 'spawn_agent', { objective: 'evidence' })) as { id: string };
    const peer = app.store.run(child.id);
    const archive = app.store.blob({ version: 1, runId: peer.id, sessionId: source.sessionId, messages: [{ role: 'tool', tool_call_id: 'historical', content: 'CHILD EVIDENCE' }] });
    app.store.event(peer.id, 'context.compacted', { archivedRef: archive });
    const resultRef = app.store.blob({ content: 'ORIGINAL TOOL PROOF' });
    app.store.putCall({ id: 'child-proof', runId: peer.id, step: 0, kind: 'tool', name: 'file.read', status: 'succeeded', effect: 'read', requestRef: app.store.blob({ path: 'proof' }), resultRef, reservedTokens: 0 });
    const next = followUp(source, app, 'follow-up');
    expect(readHistory(app.store, next.id, { ref: archive }).runId).toBe(peer.id);
    expect(inspectRun(app.store, next, { run_id: peer.id, call_id: 'child-proof' })).toMatchObject({ evidence: { text: '{"content":"ORIGINAL TOOL PROOF"}' } });
    expect(() => inspectRun(app.store, peer, { run_id: source.id })).toThrow('inspect only');
    const foreign = app.createRun({ objective: 'separate session', workspace: root, binding });
    app.store.updateRun(foreign.id, { historyFrom: source.id, continuationOf: source.id });
    expect(historyRuns(app.store, app.store.run(foreign.id)).map(run => run.id)).toEqual([foreign.id]);
    expect(() => readHistory(app.store, foreign.id, { ref: archive })).toThrow('not indexed');
    expect(() => followUpContext(app.store, source, { ...next, sessionId: foreign.sessionId })).toThrow('same-session');
    app.store.updateRun(peer.id, { historyFrom: source.id });
    expect(historyRuns(app.store, app.store.run(peer.id)).map(run => run.id)).toEqual([peer.id]);
  });

  it('grants explicit managed child continuations predecessor evidence across a chain without inheriting mailboxes', () => {
    const { app, runId } = fixture();
    const main = app.store.run(runId);
    const spawn = (objective: string, continuationOf?: string): Run => {
      const result = app.store.transaction(() => app.coordinator.mailbox.execute(main, objective, 'spawn_agent', { objective, permissions: ['read'], ...(continuationOf ? { continuation_of: continuationOf } : {}) })) as { id: string };
      return app.store.run(result.id);
    };
    const predecessor = spawn('original child');
    const sibling = spawn('unrelated sibling');
    const archive = app.store.blob({ version: 1, runId: predecessor.id, sessionId: main.sessionId, messages: [{ role: 'assistant', content: 'PREDECESSOR ARCHIVED PROOF' }] });
    app.store.event(predecessor.id, 'context.compacted', { archivedRef: archive });
    app.store.putCall({ id: 'predecessor-proof', runId: predecessor.id, step: 0, kind: 'tool', name: 'file.read', status: 'succeeded', effect: 'read', requestRef: app.store.blob({ path: 'source.txt' }), resultRef: app.store.blob({ content: 'PREDECESSOR TOOL PROOF' }), reservedTokens: 0 });
    app.store.putMessage({ id: 'predecessor-open-question', sessionId: main.sessionId, from: predecessor.id, to: sibling.id, kind: 'question', content: 'OLD CHILD QUESTION' });
    app.updateProgress(predecessor.id, { completed: ['Original child evidence collected'] });
    app.store.updateRun(predecessor.id, { status: 'completed', resultRef: app.store.blob({ text: 'PREDECESSOR RESULT' }) });
    const next = spawn('continue original child', predecessor.id);
    expect(next.historyFrom).toBe(predecessor.id);
    expect(inspectRun(app.store, next, { run_id: predecessor.id, call_id: 'predecessor-proof' })).toMatchObject({ evidence: { text: '{"content":"PREDECESSOR TOOL PROOF"}' } });
    expect(readHistory(app.store, next.id, { ref: archive }).messages[0]!.content).toBe('PREDECESSOR ARCHIVED PROOF');
    expect(recoveryHistoryRuns(app.store, next).map(run => run.id)).toEqual([next.id]);
    expect(app.store.inbox(next.id)).toEqual([]);
    expect(() => app.store.transaction(() => app.coordinator.mailbox.execute(next, 'invalid-old-wait', 'wait_for_events', { question_ids: ['predecessor-open-question'] }))).toThrow('own questions');
    expect(() => inspectRun(app.store, next, { run_id: sibling.id })).toThrow('inspect only');
    expect(() => inspectRun(app.store, next, { run_id: main.id })).toThrow('inspect only');
    const built = buildContext(app.store, next, 16_000, []);
    expect(JSON.stringify(built.messages)).toContain('Original child evidence collected');
    expect(JSON.stringify(built.messages)).not.toContain('OLD CHILD QUESTION');
    app.store.updateRun(next.id, { status: 'completed' });
    const twice = spawn('continue again', next.id);
    expect(historyRuns(app.store, twice).map(run => run.id)).toEqual([twice.id, next.id, predecessor.id]);
    expect(readHistory(app.store, twice.id, { ref: archive }).runId).toBe(predecessor.id);
    expect(inspectRun(app.store, twice, { run_id: predecessor.id, call_id: 'predecessor-proof' })).toMatchObject({ runId: predecessor.id });
  });

  it('rejects child history links lacking an exact terminal same-parent and same-session grant', () => {
    const { app, runId, root } = fixture();
    const main = app.store.run(runId);
    const original = app.store.transaction(() => app.coordinator.mailbox.execute(main, 'original', 'spawn_agent', { objective: 'original child' })) as { id: string };
    const source = app.store.updateRun(original.id, { status: 'completed' });
    const foreign = app.createRun({ objective: 'foreign session', workspace: root, binding });
    const attempts: Run[] = [
      { ...source, id: 'continuation-without-grant', continuationOf: source.id },
      { ...source, id: 'grant-without-continuation', historyFrom: source.id },
      { ...source, id: 'grant-mismatched-continuation', historyFrom: source.id, continuationOf: main.id },
      { ...source, id: 'different-parent', parentId: 'other-main', historyFrom: source.id, continuationOf: source.id },
      { ...source, id: 'foreign-session', sessionId: foreign.sessionId, historyFrom: source.id, continuationOf: source.id },
      { ...source, id: 'main-as-source', historyFrom: main.id, continuationOf: main.id },
    ];
    for (const attempt of attempts) {
      app.store.putRun(attempt);
      expect(historyRuns(app.store, attempt).map(run => run.id)).toEqual([attempt.id]);
      expect(() => inspectRun(app.store, attempt, { run_id: source.id })).toThrow('inspect only');
    }
    const validLink: Run = { ...source, id: 'nonterminal-source', historyFrom: source.id, continuationOf: source.id };
    app.store.putRun(validLink);
    app.store.updateRun(source.id, { status: 'waiting' });
    expect(historyRuns(app.store, validLink).map(run => run.id)).toEqual([validLink.id]);
    expect(() => inspectRun(app.store, validLink, { run_id: source.id })).toThrow('inspect only');
  });

  it('does not turn ordinary history grants into recovery questions, mailbox ownership or validation', () => {
    const { app, runId } = fixture();
    const source = app.store.run(runId);
    app.store.putMessage({ id: 'old-question', sessionId: source.sessionId, from: source.id, to: 'user', kind: 'question', content: 'OLD UNANSWERED QUESTION' });
    const next = followUp(source, app, 'ordinary-follow-up');
    expect(recoveryHistoryRuns(app.store, next).map(run => run.id)).toEqual([next.id]);
    expect(app.store.inbox(next.id)).toEqual([]);
    const context = app.store.readBlob<Message[]>(next.contextRef);
    const contextBudget = JSON.stringify(context).length + 8000;
    context.push({ role: 'assistant', content: 'Completed round '.repeat(4000) });
    app.store.updateRun(next.id, { contextRef: app.store.blob(context) });
    const built = buildContext(app.store, app.store.run(next.id), contextBudget, []);
    expect(JSON.stringify(built.messages)).not.toContain('OLD UNANSWERED QUESTION');
    expect(next.requiresValidation).toBeUndefined();
  });

  it('reinjects bounded durable progress across updates, compaction and followups without altering signed provider blocks', () => {
    const { app, runId } = fixture();
    const progress = { facts: ['Public API is used by an external consumer'], completed: ['Read the module'], pending: ['Verify the failure path'], evidence: ['inspect_run: child-proof'] };
    expect(updateTaskProgress(app.store, runId, progress)).toEqual(progress);
    const source = app.store.run(runId);
    const providerMessage: Message = { role: 'assistant', content: 'signed output', providerData: { protocol: 'anthropic', blocks: [{ type: 'thinking', thinking: 'immutable provider data', signature: 'signed-value' }] } };
    let messages = app.store.readBlob<Message[]>(source.contextRef);
    const contextBudget = JSON.stringify(messages).length + 8000;
    messages.push({ role: 'assistant', content: 'old output '.repeat(3000) }, providerMessage);
    app.store.updateRun(runId, { contextRef: app.store.blob(messages) });
    for (let index = 0; index < 3; index++) {
      const built = buildContext(app.store, app.store.run(runId), contextBudget, []);
      expect(built.messages).toContainEqual(providerMessage);
      expect(built.messages.filter(message => message.content?.startsWith('Task progress'))).toHaveLength(1);
      expect(JSON.stringify(built.messages)).toContain('Verify the failure path');
      app.store.updateRun(runId, { contextRef: app.store.blob(built.messages) });
      if (built.archivedRef) app.store.event(runId, 'context.compacted', { archivedRef: built.archivedRef });
      messages = app.store.readBlob<Message[]>(app.store.run(runId).contextRef);
      messages.push({ role: 'assistant', content: 'more archived output '.repeat(2000) });
      app.store.updateRun(runId, { contextRef: app.store.blob(messages) });
    }
    updateTaskProgress(app.store, runId, { ...progress, pending: ['Run the integration check'] });
    const next = followUp(app.store.run(runId), app, 'progress-follow-up');
    const content = JSON.stringify(app.store.readBlob(next.contextRef));
    expect(content).toContain('Run the integration check');
    expect(content).not.toContain('Verify the failure path');
    expect(() => updateTaskProgress(app.store, runId, { ...progress, facts: ['x'.repeat(801)] })).toThrow('progress requires');
    expect(app.store.events(runId).filter(event => event.type === 'task.progress.updated')).toHaveLength(2);
    app.store.updateRun(runId, { status: 'completed' });
    expect(() => updateTaskProgress(app.store, runId, { pending: ['New work'] })).toThrow('terminal run progress is immutable');
    expect(app.store.events(runId).filter(event => event.type === 'task.progress.updated')).toHaveLength(2);
  });
});
