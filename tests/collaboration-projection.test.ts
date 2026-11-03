import { storageTestConnection } from '../src/storage/test-access.js';
import { describe, expect, it } from 'vitest';
import { Application } from '../src/application/index.js';
import type { Envelope, Provider, Run, RunStatus, Wait } from '../src/runtime/types.js';
import { collaborationView } from '../src/web/collaboration.js';
import type { AgentView, CollaborationView, PendingView } from '../src/web/collaboration.js';
import { binding, fixture } from './helpers.js';

const RANK = { critical: 0, warning: 1, info: 2 } as const;

function setup(provider?: Provider): { app: Application; root: string; main: Run } {
  const { app, root, runId } = fixture(provider);
  return { app, root, main: app.store.run(runId) };
}

type ChildOptions = {
  id: string;
  objective?: string;
  status?: RunStatus;
  createdAt?: string;
  exploration?: Run['exploration'];
  requiresValidation?: boolean;
};

function putChild(app: Application, main: Run, options: ChildOptions): Run {
  const run: Run = {
    id: options.id,
    sessionId: main.sessionId,
    parentId: main.id,
    objective: options.objective ?? `子任务 ${options.id}`,
    status: options.status ?? 'queued',
    card: main.card,
    binding: main.binding,
    contextRef: main.contextRef,
    step: 0,
    cancelRequested: false,
    decisionVersion: 0,
    createdAt: options.createdAt ?? new Date().toISOString(),
    ...(options.exploration === undefined ? {} : { exploration: options.exploration }),
    ...(options.requiresValidation === undefined ? {} : { requiresValidation: options.requiresValidation }),
  };
  app.store.putRun(run);
  return app.store.run(run.id);
}

function finish(app: Application, runId: string, status: RunStatus, extra: Partial<Run> = {}): Run {
  app.store.updateRun(runId, { status, ...extra });
  app.store.event(runId, `run.${status}`, extra.error === undefined ? {} : { error: extra.error });
  return app.store.run(runId);
}

function putResult(app: Application, runId: string, value: unknown): string {
  const resultRef = app.store.blob(value);
  app.store.updateRun(runId, { status: 'completed', resultRef });
  app.store.event(runId, 'run.completed', { resultRef });
  return resultRef;
}

function ask(app: Application, from: Run, id: string, content: string): Envelope {
  return app.store.putMessage({ id, sessionId: from.sessionId, from: from.id, to: 'user', kind: 'question', content });
}

function answerQuestion(app: Application, asker: Run, questionId: string): void {
  app.store.putMessage({ id: `answer:${questionId}`, sessionId: asker.sessionId, from: 'user', to: asker.id, kind: 'answer', content: '好的', replyTo: questionId });
}

function putWait(app: Application, run: Run, options: { id: string; questionIds?: string[]; runIds?: string[]; deadline?: number; status?: Wait['status'] }): Wait {
  const wait: Wait = {
    id: options.id,
    runId: run.id,
    questionIds: options.questionIds ?? [],
    runIds: options.runIds ?? [],
    mode: 'any',
    deadline: options.deadline ?? Date.now() + 60_000,
    status: options.status ?? 'registered',
  };
  app.store.putWait(wait);
  app.store.updateRun(run.id, { status: 'waiting', waitId: wait.id });
  return wait;
}

function agentOf(view: CollaborationView, id: string): AgentView {
  const found = view.agents.find(agent => agent.id === id);
  if (!found) throw new Error(`agent not found: ${id}`);
  return found;
}

function pendingOf(view: CollaborationView, prefix: string): PendingView {
  const found = view.pending.find(item => item.id.startsWith(prefix));
  if (!found) throw new Error(`pending item not found: ${prefix}`);
  return found;
}

function pendingIds(view: CollaborationView): string[] {
  return view.pending.map(item => item.id);
}

function expectSorted(pending: PendingView[]): void {
  expect(new Set(pending.map(item => item.id)).size).toBe(pending.length);
  for (let index = 1; index < pending.length; index += 1) {
    const previous = pending[index - 1]!;
    const current = pending[index]!;
    const severity = RANK[previous.severity] - RANK[current.severity];
    if (severity !== 0) { expect(severity).toBeLessThan(0); continue; }
    if (previous.order !== current.order) { expect(previous.order).toBeGreaterThan(current.order); continue; }
    expect(previous.id < current.id).toBe(true);
  }
}

describe('collaborationView', () => {
  it('shows released active capacity separately from cumulative child history', () => {
    const { app, main } = setup();
    const session = app.store.session(main.sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, maxActiveChildren: 1 } });
    const first = putChild(app, main, { id: 'child-complete', status: 'running' });
    expect(collaborationView(app, main.id).children).toMatchObject({ maximum: null, maximumActive: 1, created: 1, active: 1, remainingActive: 0 });
    finish(app, first.id, 'completed');
    expect(collaborationView(app, main.id).children).toMatchObject({ maximum: null, maximumActive: 1, created: 1, active: 0, remainingActive: 1 });
    const next = putChild(app, main, { id: 'child-next' });
    app.store.updateRun(next.id, { agentId: first.id });
    const view = collaborationView(app, main.id);
    expect(view.children).toMatchObject({ created: 2, active: 1, remainingActive: 0 });
    expect(agentOf(view, next.id).agentId).toBe(first.id);
  });
  it('anchors direct children behind the main task and ignores unrelated roots', () => {
    const { app, main } = setup();
    const otherRoot: Run = { ...main, id: 'other-root', objective: '另一个根任务' };
    app.store.putRun(otherRoot);
    app.store.putRun({ ...otherRoot, id: 'other-child', parentId: otherRoot.id });
    const first = putChild(app, main, { id: 'child-first', status: 'running' });
    const second = putChild(app, main, { id: 'child-second' });

    const view = collaborationView(app, main.id);
    expect(view.anchorRunId).toBe(main.id);
    expect(view.sessionId).toBe(main.sessionId);
    expect(view.decisionVersion).toBe(0);
    expect(view.agents.map(agent => agent.id)).toEqual([main.id, first.id, second.id]);
    expect(view.agents[0]).toMatchObject({ role: 'main', status: 'queued', state: 'queued', result: null, blocked: null });
    expect(view.agents[0]!.parentId).toBeUndefined();
    expect(view.agents[1]).toMatchObject({ role: 'child', parentId: main.id, state: 'running' });
    // Session-wide capacity counts every child, not only this anchor's children.
    expect(view.children).toEqual({ maximum: null, maximumActive: 8, created: 3, active: 3, remainingActive: 5 });
    expect(Number.isNaN(Date.parse(view.generatedAt))).toBe(false);

    const fromChild = collaborationView(app, first.id);
    expect(fromChild.anchorRunId).toBe(main.id);
    expect(fromChild.agents.map(agent => agent.id)).toEqual([main.id, first.id, second.id]);
    expect(() => collaborationView(app, 'missing-run')).toThrow();
  });

  it('maps waiting states and blocked details from registered waits', () => {
    const { app, main } = setup();
    const runningPeer = putChild(app, main, { id: 'peer-running', status: 'running' });
    const userWaiter = putChild(app, main, { id: 'waiter-user', status: 'waiting' });
    const question = ask(app, userWaiter, 'question-waiter', '选 A 还是 B？');
    const userWait = putWait(app, userWaiter, { id: 'wait-user', questionIds: [question.id], deadline: 4_000_000_000_000 });
    const peerWaiter = putChild(app, main, { id: 'waiter-peer', status: 'waiting' });
    putWait(app, peerWaiter, { id: 'wait-peer', runIds: [runningPeer.id] });
    const answeredWaiter = putChild(app, main, { id: 'waiter-answered', status: 'waiting' });
    const answered = ask(app, answeredWaiter, 'question-answered', '已回答的问题');
    answerQuestion(app, answeredWaiter, answered.id);
    putWait(app, answeredWaiter, { id: 'wait-answered', questionIds: [answered.id] });
    const bareWaiter = putChild(app, main, { id: 'waiter-bare', status: 'waiting' });
    const timedOut = putChild(app, main, { id: 'waiter-timeout', status: 'waiting' });
    putWait(app, timedOut, { id: 'wait-timeout', deadline: Date.now() - 1_000 });

    const view = collaborationView(app, main.id);
    expect(agentOf(view, main.id).state).toBe('queued');
    expect(agentOf(view, runningPeer.id).state).toBe('running');
    expect(agentOf(view, userWaiter.id).state).toBe('waiting_user');
    expect(agentOf(view, userWaiter.id).blocked).toMatchObject({ reason: 'user_question', questionIds: [question.id], runIds: [], until: userWait.deadline });
    expect(agentOf(view, peerWaiter.id).state).toBe('waiting_peer');
    expect(agentOf(view, peerWaiter.id).blocked).toMatchObject({ reason: 'peer', questionIds: [], runIds: [runningPeer.id] });
    expect(agentOf(view, peerWaiter.id).blocked!.until).toEqual(expect.any(Number));
    expect(agentOf(view, answeredWaiter.id).state).toBe('waiting');
    expect(agentOf(view, answeredWaiter.id).blocked).toMatchObject({ reason: null, questionIds: [], runIds: [] });
    expect(agentOf(view, bareWaiter.id).state).toBe('waiting');
    expect(agentOf(view, bareWaiter.id).blocked).toBeNull();
    expect(agentOf(view, timedOut.id).state).toBe('waiting');
    expect(agentOf(view, timedOut.id).blocked).toMatchObject({ reason: 'timeout' });
  });

  it('projects unanswered user questions with stable IDs and excludes non-panel or terminal owners', () => {
    const { app, main } = setup();
    const child = putChild(app, main, { id: 'child-question', objective: '子任务需要确认', status: 'running' });
    const otherRoot: Run = { ...main, id: 'other-root', objective: '其他根任务' };
    app.store.putRun(otherRoot);
    const terminalChild = finish(app, putChild(app, main, { id: 'child-terminal' }).id, 'cancelled');
    const fromChild = ask(app, child, 'question-child', '继续执行吗？');
    const fromMain = ask(app, main, 'question-main', '选择哪个方向？');
    answerQuestion(app, main, fromMain.id);
    const fromTerminal = ask(app, terminalChild, 'question-terminal', '已完成任务的提问');
    const fromOutside = ask(app, otherRoot, 'question-outside', '面板外的提问');

    const view = collaborationView(app, main.id);
    expect(pendingIds(view)).toEqual([`question:${fromChild.id}`]);
    const item = pendingOf(view, 'question:');
    expect(item).toMatchObject({
      kind: 'question', severity: 'warning', runId: child.id, role: 'child',
      agentObjective: '子任务需要确认', questionId: fromChild.id, order: fromChild.seq, actions: ['answer', 'view_agent'],
    });
    expect(item.detail).toBe('继续执行吗？');
    expect(app.store.answer(fromMain.id)).toBeDefined();
    const created = app.store.events(child.id).find(event => event.type === 'message.created' && event.data['messageId'] === fromChild.id);
    expect(item.createdAt).toBe(created!.time);
    expect(view.pending.some(entry => entry.id === `question:${fromTerminal.id}`)).toBe(false);
    expect(view.pending.some(entry => entry.id === `question:${fromOutside.id}`)).toBe(false);
    expect(`${agentOf(view, child.id).updatedAt}`).toBe(app.store.events(child.id).at(-1)!.time);
  });

  it('distinguishes failed agents from uncertain writes', () => {
    const { app, main } = setup();
    const failed = finish(app, putChild(app, main, { id: 'child-failed' }).id, 'failed', { error: 'MODEL_BUDGET: model call or token budget exhausted' });
    const unknown = finish(app, putChild(app, main, { id: 'child-unknown', requiresValidation: true }).id, 'failed', { error: 'UNKNOWN_WRITE: write result is uncertain; inspect before continuing' });
    const view = collaborationView(app, main.id);
    expect(pendingOf(view, `failed:${failed.id}`)).toMatchObject({
      kind: 'failed', severity: 'critical', runId: failed.id, role: 'child', actions: ['view_agent', 'inspect'],
    });
    expect(pendingOf(view, `failed:${failed.id}`).detail).toContain('MODEL_BUDGET');
    expect(view.pending.some(entry => entry.id === `unknown_write:${failed.id}`)).toBe(false);
    expect(pendingOf(view, `unknown_write:${unknown.id}`)).toMatchObject({
      kind: 'unknown_write', severity: 'critical', role: 'child', actions: ['view_agent', 'inspect'],
    });
    expect(view.pending.some(entry => entry.id === `failed:${unknown.id}`)).toBe(false);
    expect(agentOf(view, unknown.id)).toMatchObject({ state: 'failed', requiresValidation: true });
    expect(agentOf(view, unknown.id).blocked).toMatchObject({ reason: 'validation', questionIds: [], runIds: [], until: null });
    expect(agentOf(view, failed.id).requiresValidation).toBe(false);
  });

  it('reports interrupted runs and offers resume only for the main task', () => {
    const { app, main } = setup();
    const interruptedMain = finish(app, main.id, 'interrupted', { error: 'previous process exited before finishing' });
    const interruptedChild = finish(app, putChild(app, interruptedMain, { id: 'child-interrupted' }).id, 'interrupted');
    const view = collaborationView(app, main.id);
    expect(pendingOf(view, `interrupted:${main.id}`)).toMatchObject({
      kind: 'interrupted', severity: 'warning', role: 'main', actions: ['resume', 'view_agent', 'inspect'],
    });
    expect(agentOf(view, main.id).state).toBe('interrupted');
    expect(pendingOf(view, `interrupted:${interruptedChild.id}`)).toMatchObject({
      kind: 'interrupted', severity: 'warning', role: 'child', actions: ['view_agent', 'inspect'],
    });
    expect(agentOf(view, interruptedChild.id).state).toBe('interrupted');
    expect(agentOf(view, interruptedMain.id).error).toContain('previous process exited');
  });

  it('flags unverified results and promotes stale ones to warning', () => {
    const { app, main } = setup();
    const unchecked = putChild(app, main, { id: 'child-unchecked' });
    const uncheckedRef = putResult(app, unchecked.id, { text: '已完成但未验收', quality: { status: 'not_checked' } });
    const passed = putChild(app, main, { id: 'child-passed' });
    putResult(app, passed.id, { text: '已通过验收', quality: { status: 'passed' } });
    const failedQuality = putChild(app, main, { id: 'child-quality-failed' });
    putResult(app, failedQuality.id, { text: '验收失败', quality: { status: 'failed' } });
    const missing = putChild(app, main, { id: 'child-missing-blob' });
    app.store.updateRun(missing.id, { status: 'completed', resultRef: 'a'.repeat(64) });
    app.store.event(missing.id, 'run.completed', { resultRef: 'a'.repeat(64) });
    const bare = finish(app, putChild(app, main, { id: 'child-completed-no-result' }).id, 'completed');

    let view = collaborationView(app, main.id);
    const item = pendingOf(view, `unverified_result:${unchecked.id}:`);
    expect(item.id).toBe(`unverified_result:${unchecked.id}:${uncheckedRef}`);
    expect(item).toMatchObject({ kind: 'unverified_result', severity: 'info', runId: unchecked.id, role: 'child', actions: ['view_agent', 'inspect'] });
    expect(agentOf(view, unchecked.id).result).toMatchObject({ available: true, quality: 'not_checked', stale: false, truncated: false, summary: '已完成但未验收' });
    expect(view.pending.some(entry => entry.id.startsWith(`unverified_result:${passed.id}:`))).toBe(false);
    expect(agentOf(view, passed.id).result?.quality).toBe('passed');
    expect(pendingOf(view, `unverified_result:${failedQuality.id}:`).severity).toBe('info');
    expect(agentOf(view, failedQuality.id).result?.quality).toBe('failed');
    expect(agentOf(view, missing.id).result).toMatchObject({ available: false, quality: 'unknown', resultRef: 'a'.repeat(64), summary: '' });
    expect(view.pending.some(entry => entry.id.startsWith(`unverified_result:${missing.id}:`))).toBe(true);
    expect(agentOf(view, bare.id).result).toBeNull();
    expect(view.pending.some(entry => entry.id.startsWith(`unverified_result:${bare.id}:`))).toBe(false);

    // A later user decision makes existing results need review; stale is not an acceptance failure.
    app.store.putSession({ ...app.store.session(main.sessionId), decisionVersion: 1 });
    view = collaborationView(app, main.id);
    expect(view.decisionVersion).toBe(1);
    const stale = pendingOf(view, `unverified_result:${unchecked.id}:`);
    expect(stale.id).toBe(`unverified_result:${unchecked.id}:${uncheckedRef}`);
    expect(stale.severity).toBe('warning');
    expect(stale.detail).toContain('复核');
    expect(agentOf(view, unchecked.id)).toMatchObject({ stale: true, decisionVersion: 0 });
    expect(agentOf(view, unchecked.id).result?.stale).toBe(true);
    expect(pendingOf(view, `unverified_result:${failedQuality.id}:`).severity).toBe('warning');
  });

  it('reports a run whose latest persisted event is a failed web command', () => {
    const { app, main } = setup();
    const child = putChild(app, main, { id: 'child-command', status: 'running' });
    app.store.event(child.id, 'web.command_failed', { action: 'input', code: 'NOT_INTERRUPTED', message: 'Only interrupted runs can be resumed' });
    const recovered = putChild(app, main, { id: 'child-command-recovered', status: 'running' });
    app.store.event(recovered.id, 'web.command_failed', { action: 'run', code: 'WEB_EXECUTION', message: 'Execution failed' });
    app.store.event(recovered.id, 'run.started', {});

    const view = collaborationView(app, main.id);
    const event = app.store.events(child.id).at(-1)!;
    expect(pendingOf(view, `command_failed:${child.id}:`)).toMatchObject({
      kind: 'command_failed', severity: 'warning', runId: child.id, role: 'child',
      order: event.seq, createdAt: event.time, actions: ['view_agent', 'inspect'],
    });
    expect(pendingOf(view, `command_failed:${child.id}:`).detail).toContain('NOT_INTERRUPTED');
    expect(view.pending.some(entry => entry.kind === 'command_failed' && entry.runId === recovered.id)).toBe(false);
  });

  it('reports blocked coordination from the latest wait.deadlock event', () => {
    const { app, main } = setup();
    const peer = putChild(app, main, { id: 'peer-deadlock', status: 'running' });
    const waiting = putChild(app, main, { id: 'child-deadlock' });
    app.store.event(waiting.id, 'wait.deadlock', { runs: [waiting.id, peer.id] });
    const firstEvent = app.store.events(waiting.id).at(-1)!;
    const view = collaborationView(app, main.id);
    expect(pendingOf(view, `blocked:${waiting.id}:`)).toMatchObject({
      kind: 'blocked', severity: 'warning', runId: waiting.id, role: 'child',
      order: firstEvent.seq, createdAt: firstEvent.time, actions: ['view_agent'],
    });
    expect(pendingOf(view, `blocked:${waiting.id}:`).detail).toContain('死锁');

    app.store.event(waiting.id, 'wait.deadlock', { runs: [waiting.id] });
    const latest = app.store.events(waiting.id).at(-1)!;
    const next = collaborationView(app, main.id);
    expect(pendingOf(next, `blocked:${waiting.id}:`).id).toBe(`blocked:${waiting.id}:${latest.seq}`);

    // Historical deadlocks on terminal records must not stay actionable forever.
    const finished = finish(app, putChild(app, main, { id: 'child-deadlock-done' }).id, 'completed');
    app.store.event(finished.id, 'wait.deadlock', { runs: [finished.id] });
    expect(collaborationView(app, main.id).pending.some(entry => entry.kind === 'blocked' && entry.runId === finished.id)).toBe(false);
  });

  it('sorts pending by severity, recency and ID and never duplicates on repeated reads', () => {
    const { app, main } = setup();
    finish(app, putChild(app, main, { id: 'child-failed' }).id, 'failed', { error: 'MODEL_BUDGET: exhausted' });
    finish(app, putChild(app, main, { id: 'child-unknown' }).id, 'failed', { error: 'UNKNOWN_WRITE: uncertain' });
    finish(app, putChild(app, main, { id: 'child-interrupted' }).id, 'interrupted', { error: 'process exited before finishing' });
    const completed = putChild(app, main, { id: 'child-completed' });
    putResult(app, completed.id, { text: '未验收的结果', quality: { status: 'not_checked' } });
    const questionRun = putChild(app, main, { id: 'child-question', status: 'running' });
    ask(app, questionRun, 'question-sort', '需要回答');
    const command = putChild(app, main, { id: 'child-command' });
    app.store.event(command.id, 'web.command_failed', { action: 'cancel', code: 'WEB_EXECUTION', message: 'failed' });
    const deadlock = putChild(app, main, { id: 'child-deadlock' });
    app.store.event(deadlock.id, 'wait.deadlock', { runs: [deadlock.id] });

    const first = collaborationView(app, main.id);
    expect(first.pending.map(entry => entry.kind)).toEqual([
      'unknown_write', 'failed', 'blocked', 'command_failed', 'interrupted', 'question', 'unverified_result',
    ]);
    expectSorted(first.pending);

    const second = collaborationView(app, main.id);
    expect(pendingIds(second)).toEqual(pendingIds(first));
    expect(new Set(pendingIds(second)).size).toBe(second.pending.length);
    expect({ ...second, generatedAt: '' }).toEqual({ ...first, generatedAt: '' });
  });

  it('summarizes results with redaction, exploration JSON and surrogate-safe truncation', () => {
    const previous = process.env.KODO_TEST_KEY;
    process.env.KODO_TEST_KEY = 'kodo-secret-value-42';
    try {
      const { app, main } = setup();
      const plain = putChild(app, main, { id: 'child-plain' });
      putResult(app, plain.id, { text: `结果 kodo-secret-value-42 ${'字'.repeat(700)}`, quality: { status: 'passed' } });
      const surrogate = putChild(app, main, { id: 'child-surrogate' });
      putResult(app, surrogate.id, { text: `${'a'.repeat(599)}😀tail`, quality: { status: 'not_checked' } });
      const exploration = putChild(app, main, {
        id: 'child-exploration',
        exploration: { questionId: 'q1', batchId: 'b1', decisionVersion: 0, consumer: 'main', deliverable: 'answer', knowledgeRefs: [] },
      });
      putResult(app, exploration.id, { text: JSON.stringify({ summary: '探索结论 kodo-secret-value-42', open_questions: [] }), quality: { status: 'not_checked' } });

      const view = collaborationView(app, main.id);
      const plainResult = agentOf(view, plain.id).result!;
      expect(plainResult.quality).toBe('passed');
      expect(plainResult.truncated).toBe(true);
      expect(plainResult.summary.length).toBe(600);
      expect(plainResult.summary).not.toContain('kodo-secret-value-42');
      expect(plainResult.summary).toContain('[REDACTED]');

      const surrogateResult = agentOf(view, surrogate.id).result!;
      expect(surrogateResult.truncated).toBe(true);
      expect(surrogateResult.summary).toBe('a'.repeat(599));
      expect(/[\uD800-\uDBFF]$/.test(surrogateResult.summary)).toBe(false);

      expect(agentOf(view, exploration.id).result?.summary).toBe('探索结论 [REDACTED]');
      expect(agentOf(view, exploration.id).result?.quality).toBe('not_checked');

      const asker = putChild(app, main, { id: 'child-long-question', status: 'running' });
      ask(app, asker, 'question-long', `你是否允许 kodo-secret-value-42 ${'问'.repeat(300)}`);
      const longQuestion = pendingOf(collaborationView(app, main.id), 'question:question-long');
      expect(longQuestion.detail.length).toBe(160);
      expect(longQuestion.detail).not.toContain('kodo-secret-value-42');
      expect(longQuestion.detail).toContain('[REDACTED]');
    } finally {
      if (previous === undefined) delete process.env.KODO_TEST_KEY;
      else process.env.KODO_TEST_KEY = previous;
    }
  });

  it('derives updatedAt from durable events and never exposes binding credentials', () => {
    const previous = process.env.KODO_TEST_KEY;
    process.env.KODO_TEST_KEY = 'kodo-secret-value-42';
    try {
      const { app, main } = setup();
      const createdAt = '2026-01-01T00:00:00.000Z';
      const child = putChild(app, main, { id: 'child-events', createdAt });
      const unknown = finish(app, putChild(app, main, { id: 'child-unknown-secret' }).id, 'failed', {
        error: 'UNKNOWN_WRITE: kodo-secret-value-42 is uncertain',
      });
      app.store.event(main.id, 'test.marker', {});
      const view = collaborationView(app, main.id);
      const lastEvent = app.store.events(main.id).at(-1)!;
      expect(agentOf(view, main.id).updatedAt).toBe(lastEvent.time);
      expect(agentOf(view, child.id).updatedAt).toBe(createdAt);
      expect(agentOf(view, unknown.id).error).toBe('UNKNOWN_WRITE: [REDACTED] is uncertain');
      expect(pendingOf(view, `unknown_write:${unknown.id}`).detail).not.toContain('kodo-secret-value-42');

      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain('kodo-secret-value-42');
      expect(serialized).not.toContain(binding.baseURL);
      expect(serialized).not.toContain('apiKeyEnv');
      expect(serialized).not.toContain('binding');
      for (const agent of view.agents) expect(agent).not.toHaveProperty('binding');
    } finally {
      if (previous === undefined) delete process.env.KODO_TEST_KEY;
      else process.env.KODO_TEST_KEY = previous;
    }
  });

  it('is a read-only projection with stable repeated output and no model calls', () => {
    const { app, main } = setup({
      async complete() { throw new Error('projection must not call the model'); },
    });
    const child = putChild(app, main, { id: 'child-readonly', status: 'waiting' });
    const question = ask(app, child, 'question-readonly', '继续？');
    putWait(app, child, { id: 'wait-readonly', questionIds: [question.id] });
    finish(app, putChild(app, main, { id: 'child-failed-readonly' }).id, 'failed', { error: 'MODEL_BUDGET: exhausted' });
    const counts = () => ({
      runs: app.store.listRuns().length,
      events: (storageTestConnection(app.store).prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count,
      messages: (storageTestConnection(app.store).prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count,
      waits: (storageTestConnection(app.store).prepare('SELECT COUNT(*) AS count FROM waits').get() as { count: number }).count,
      calls: (storageTestConnection(app.store).prepare('SELECT COUNT(*) AS count FROM calls').get() as { count: number }).count,
    });
    const before = counts();
    const fromChild = collaborationView(app, child.id);
    const fromMain = collaborationView(app, main.id);
    expect(counts()).toEqual(before);
    expect(fromChild.anchorRunId).toBe(main.id);
    expect(fromChild.agents.map(agent => agent.id)).toEqual(fromMain.agents.map(agent => agent.id));
    expect(pendingIds(fromChild)).toEqual(pendingIds(fromMain));
    expect({ ...fromChild, generatedAt: '' }).toEqual({ ...fromMain, generatedAt: '' });
  });
});
