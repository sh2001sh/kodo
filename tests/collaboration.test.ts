import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import type { Envelope, Message, ModelResponse, Provider, Run, Wait } from '../src/runtime/types.js';
import { answer, binding, call, calls, fixture, scripted } from './helpers.js';

function operation(app: Application, runId: string, name: string, args: Record<string, unknown>, callId = name): Record<string, unknown> {
  return app.store.transaction(() => {
    const run = app.store.run(runId);
    return app.coordinator.mailbox.execute(run, callId, name, app.coordinator.mailbox.validate(run, name, JSON.stringify(args))) as Record<string, unknown>;
  });
}
function child(app: Application, mainId: string, objective = 'child task'): string {
  return operation(app, mainId, 'spawn_agent', { objective }).id as string;
}
function question(app: Application, from: string, to: string, id = 'question'): string {
  return operation(app, from, 'send_message', { to, kind: 'question', content: `Question ${id}`, message_id: id }).id as string;
}
function received(app: Application, runId: string): void {
  app.store.updateRun(runId, { inputCursor: app.store.inbox(runId).at(-1)?.seq ?? app.store.run(runId).inputCursor ?? 0 });
}
function wait(app: Application, runId: string, args: Record<string, unknown>): Wait {
  const result = operation(app, runId, 'wait_for_events', args);
  const record = app.store.wait(result.waitId as string);
  if (record.status === 'registered') app.store.updateRun(runId, { status: 'waiting' });
  return record;
}
function generous(app: Application, runId: string, limits: Record<string, number> = {}): void {
  const session = app.store.session(app.store.run(runId).sessionId);
  app.store.putSession({ ...session, budget: { ...session.budget, maxTokens: 2_000_000, maxContextChars: 200_000, maxModelCalls: 100, ...limits } });
}
function requestRun(app: Application, request: Parameters<Provider['complete']>[0]): Run {
  const identity = request.messages.find(x => x.role === 'system')!.content!;
  const runId = /Run ID: ([^. ]+)\./.exec(identity)?.[1];
  if (!runId) throw new Error('provider request has no runtime identity');
  return app.store.run(runId);
}
function delivered(request: Parameters<Provider['complete']>[0]): Envelope[] {
  return request.messages.flatMap(x => x.role === 'user' && (x.content.startsWith('Runtime-delivered message;') || x.content.startsWith('User input: ')) ? [JSON.parse(x.content.slice(x.content.indexOf(': ') + 2)) as Envelope] : []);
}

describe('collaboration through the unified loop', () => {
  it('runs two independent children that directly exchange a question and answer while main waits', async () => {
    let mainId = '';
    let writerId = '';
    let reviewerId = '';
    const seenContexts: { id: string; messages: Message[] }[] = [];
    const provider: Provider = { async complete(request) {
      const run = requestRun(app, request);
      seenContexts.push({ id: run.id, messages: request.messages });
      if (run.id === mainId) {
        if (run.step === 0) return calls(call('spawn_agent', { objective: 'writer', context: 'Write with review evidence' }, 'spawn-writer'), call('spawn_agent', { objective: 'reviewer', context: 'Answer writer directly' }, 'spawn-reviewer'));
        if (run.step === 1) {
          const peers = app.store.listRuns().filter(x => x.parentId === mainId);
          writerId = peers.find(x => x.objective === 'writer')!.id;
          reviewerId = peers.find(x => x.objective === 'reviewer')!.id;
          return calls(call('wait_for_events', { run_ids: [writerId, reviewerId], mode: 'all' }, 'join'));
        }
        expect(app.store.run(writerId).status).toBe('completed');
        expect(app.store.run(reviewerId).status).toBe('completed');
        return answer('Main verified both child results');
      }
      expect(JSON.stringify(request.messages)).not.toContain('MAIN_PRIVATE_HISTORY');
      if (run.objective === 'writer') {
        reviewerId = app.store.listRuns().find(x => x.parentId === mainId && x.objective === 'reviewer')!.id;
        if (run.step === 0) return calls(call('send_message', { to: reviewerId, kind: 'question', content: 'What is the acceptance marker?', message_id: 'acceptance' }, 'ask-reviewer'), call('wait_for_events', { question_ids: [`${run.id}:acceptance`], mode: 'all' }, 'wait-review'));
        expect(delivered(request).some(x => x.kind === 'answer' && x.content === 'VERIFIED_MARKER')).toBe(true);
        return answer('Writer used VERIFIED_MARKER');
      }
      if (run.step === 0) {
        const query = (): Envelope | undefined => app.store.messages(run.sessionId).find(x => x.to === run.id && x.kind === 'question');
        const incoming = query() ?? await new Promise<Envelope>(resolve => {
          const off = app.store.subscribe(() => { const found = query(); if (found) { off(); resolve(found); } });
        });
        return calls(call('send_message', { to: incoming.from, kind: 'answer', reply_to: incoming.id, content: 'VERIFIED_MARKER' }, 'answer-writer'));
      }
      return answer('Reviewer answered directly');
    } };
    const f = fixture(provider);
    const app = f.app;
    mainId = f.runId;
    generous(app, mainId);
    const main = app.store.run(mainId);
    app.store.updateRun(mainId, { contextRef: app.store.blob([...app.store.readBlob<Message[]>(main.contextRef), { role: 'user', content: 'MAIN_PRIVATE_HISTORY' }]) });
    const result = await app.run(mainId);
    expect(result.status).toBe('completed');
    const messages = app.store.messages(main.sessionId);
    const directAnswer = messages.find(x => x.kind === 'answer')!;
    expect(directAnswer).toMatchObject({ from: reviewerId, to: writerId, replyTo: `${writerId}:acceptance`, content: 'VERIFIED_MARKER' });
    expect(messages.filter(x => x.to === mainId && x.kind === 'answer')).toHaveLength(0);
    expect(seenContexts.some(x => x.id === writerId)).toBe(true);
    expect(seenContexts.some(x => x.id === reviewerId)).toBe(true);
    const session = app.store.session(main.sessionId);
    expect(session.modelCalls).toBe(seenContexts.length);
    expect(session.tokens).toBe(seenContexts.length * 80);
    for (const peer of app.store.listRuns()) {
      const history = app.store.readBlob<Message[]>(peer.contextRef);
      for (const [index, message] of history.entries()) if (message.role === 'tool') {
        const preceding = history.slice(0, index).findLast(x => x.role === 'assistant');
        expect(preceding?.role === 'assistant' && preceding.tool_calls?.some(x => x.id === message.tool_call_id)).toBe(true);
      }
    }
  });

  it.each(['before registration', 'after suspension'] as const)('delivers an answer %s without a lost wakeup', async timing => {
    let questionId = '';
    const { app, runId } = fixture(scripted(async () => calls(call('wait_for_events', { question_ids: [questionId] }, 'wait-answer')), async request => {
      expect(delivered(request).some(x => x.kind === 'answer' && x.replyTo === questionId)).toBe(true);
      return answer('answer received');
    }));
    generous(app, runId);
    const peer = child(app, runId);
    questionId = question(app, runId, peer);
    const reply = (): void => { operation(app, peer, 'send_message', { to: runId, kind: 'answer', reply_to: questionId, content: 'accepted' }); };
    if (timing === 'before registration') reply();
    const initial = await app.coordinator.wake(runId);
    if (timing === 'after suspension') {
      expect(initial.status).toBe('waiting');
      reply();
      expect(app.store.run(runId).status).toBe('queued');
    }
    const result = await app.coordinator.wake(runId);
    expect(result.status).toBe('completed');
    expect(app.store.waits().find(x => x.runId === runId)).toMatchObject({ status: 'settled', reason: 'conditions_met' });
  });

  it.each(['wait.registered', 'tool.finished'] as const)('rechecks an answer injected at %s before suspending', async injectAt => {
    let questionId = '';
    const { app, runId } = fixture(scripted(async () => calls(call('wait_for_events', { question_ids: [questionId] }, 'await-reply')), async request => {
      expect(delivered(request).some(x => x.kind === 'answer' && x.content === 'in the gap')).toBe(true);
      return answer('race handled');
    }));
    generous(app, runId);
    const peer = child(app, runId);
    questionId = question(app, runId, peer);
    let inserted = false;
    const off = app.store.subscribe(event => {
      if (inserted || event.runId !== runId || event.type !== injectAt || (injectAt === 'tool.finished' && event.data.name !== 'wait_for_events')) return;
      inserted = true;
      operation(app, peer, 'send_message', { to: runId, kind: 'answer', reply_to: questionId, content: 'in the gap' });
    });
    try { expect((await app.coordinator.wake(runId)).status).toBe('completed'); }
    finally { off(); }
    expect(inserted).toBe(true);
    expect(app.store.events(runId).filter(x => x.type === 'run.waiting')).toHaveLength(0);
  });

  it.each([
    ['wait first', [call('wait_for_events', { run_ids: ['placeholder'] }, 'wait'), call('file.apply_patch', { path: 'should-not-exist.txt', expectedHash: null, content: 'forbidden' }, 'write')]],
    ['two controls', [call('file.apply_patch', { path: 'should-not-exist.txt', expectedHash: null, content: 'forbidden' }, 'write'), call('ask_user', { question: 'First question' }, 'ask'), call('wait_for_events', { run_ids: ['placeholder'] }, 'wait')]],
  ] as const)('rejects the entire %s batch before any file or collaboration write', async (_label, requests) => {
    const { app, root, runId } = fixture(scripted(calls(...requests), async request => {
      const results = request.messages.filter(x => x.role === 'tool');
      expect(results).toHaveLength(requests.length);
      for (const result of results) expect(result.content).toContain('CONTROL_BATCH');
      return answer('invalid batch rejected');
    }));
    generous(app, runId);
    expect((await app.coordinator.wake(runId)).status).toBe('completed');
    expect(existsSync(path.join(root, 'should-not-exist.txt'))).toBe(false);
    expect(app.store.events(runId).filter(x => x.type === 'tool.started')).toHaveLength(0);
    expect(app.store.messages(app.store.run(runId).sessionId)).toHaveLength(0);
    expect(app.store.waits()).toHaveLength(0);
  });

  it('persists a wait across process restart and drives the same child and main loops', async () => {
    let peer = '';
    const { app, runId } = fixture(scripted(async () => calls(call('wait_for_events', { run_ids: [peer], mode: 'all' }, 'persisted-wait'))));
    generous(app, runId);
    peer = child(app, runId, 'finish after reopen');
    expect((await app.coordinator.wake(runId)).status).toBe('waiting');
    const directory = app.store.directory;
    app.close();
    const reopened: Application = new Application(directory, { async complete(request) {
      const run = requestRun(reopened, request);
      if (!run.parentId) {
        expect(delivered(request).some(x => x.kind === 'event' && x.content.includes('conditions_met'))).toBe(true);
        expect(reopened.store.run(peer).status).toBe('completed');
      }
      return answer(run.parentId ? 'durable child result' : 'recovered join result');
    } });
    try {
      expect(reopened.store.run(runId).status).toBe('waiting');
      expect((await reopened.run(runId)).status).toBe('completed');
      expect(reopened.store.calls(runId).filter(x => x.name === 'wait_for_events')).toHaveLength(1);
    } finally { reopened.close(); }
  });
});

describe('durable mailbox boundaries', () => {
  it('limits child control capabilities and permission grants', () => {
    const { app, runId } = fixture();
    const peer = child(app, runId);
    const specs = app.coordinator.mailbox.specs(app.store.run(peer)).map(x => x.name);
    for (const [name, args] of [
      ['spawn_agent', { objective: 'grandchild' }],
      ['ask_user', { question: 'bypass main' }],
      ['cancel_agent', { run_id: runId }],
    ] as const) {
      expect(specs).not.toContain(name);
      expect(() => operation(app, peer, name, args)).toThrow('not available to a child');
    }
    expect(() => operation(app, runId, 'spawn_agent', { objective: 'elevated', permissions: ['exec'] })).toThrow('subset');
    const restricted = operation(app, runId, 'spawn_agent', { objective: 'readonly', permissions: ['read'] }).id as string;
    expect(app.store.run(restricted).permissions).toEqual(['read']);
    expect(app.store.listRuns()).toHaveLength(3);
  });

  it('only lets main cancel its own managed child and terminal peers return explicit status', () => {
    const { app, runId } = fixture();
    const first = child(app, runId);
    const second = child(app, runId);
    expect(() => operation(app, runId, 'cancel_agent', { run_id: runId })).toThrow('managed');
    expect(operation(app, runId, 'cancel_agent', { run_id: first })).toMatchObject({ id: first, status: 'cancelled' });
    expect(operation(app, second, 'send_message', { to: first, kind: 'notice', content: 'late data' })).toEqual({ target_status: 'cancelled', delivered: false });
  });

  it('rejects cross-session addressing, waiting, answers and artifacts', () => {
    const { app, root, runId } = fixture();
    const outsider = app.createRun({ objective: 'other session', workspace: root, binding });
    const peer = child(app, runId);
    expect(() => operation(app, runId, 'send_message', { to: outsider.id, kind: 'notice', content: 'no' })).toThrow('this session');
    expect(() => operation(app, runId, 'wait_for_events', { run_ids: [outsider.id] })).toThrow('this session');
    expect(() => operation(app, runId, 'cancel_agent', { run_id: outsider.id })).toThrow('this session');
    const q = question(app, runId, peer);
    expect(() => operation(app, outsider.id, 'send_message', { to: runId, kind: 'answer', reply_to: q, content: 'forged' })).toThrow('this session');
    const artifact = app.store.artifact(outsider.id, app.store.blob({ evidence: 'private session' }));
    expect(() => operation(app, runId, 'send_message', { to: peer, kind: 'notice', content: 'forged evidence', artifacts: [artifact] })).toThrow('this session');
    expect(app.store.messages(outsider.sessionId)).toHaveLength(0);
  });

  it('deduplicates stable message IDs and rejects reused IDs with conflicting content', () => {
    const { app, runId } = fixture();
    const peer = child(app, runId);
    const args = { to: peer, kind: 'question', content: 'one logical question', message_id: 'stable' };
    const first = operation(app, runId, 'send_message', args, 'attempt-one');
    const second = operation(app, runId, 'send_message', args, 'attempt-two');
    expect(first.id).toBe(second.id);
    expect(app.store.messages(app.store.run(runId).sessionId)).toHaveLength(1);
    expect(() => operation(app, runId, 'send_message', { ...args, content: 'different payload' })).toThrow('different content');
    const reply = { to: runId, kind: 'answer', reply_to: first.id, content: 'one answer' };
    const answerOne = operation(app, peer, 'send_message', reply, 'reply-one');
    expect(operation(app, peer, 'send_message', reply, 'reply-two')).toEqual({ id: answerOne.id, status: 'already_answered' });
    expect(app.store.messages(app.store.run(runId).sessionId)).toHaveLength(2);
  });

  it('rejects answering someone else’s question and waiting on a question you did not send', () => {
    const { app, runId } = fixture();
    const recipient = child(app, runId);
    const other = child(app, runId);
    const q = question(app, runId, recipient);
    expect(() => operation(app, other, 'send_message', { to: runId, kind: 'answer', reply_to: q, content: 'forged' })).toThrow('addressed to this sender');
    expect(() => operation(app, recipient, 'wait_for_events', { question_ids: [q] })).toThrow('your own questions');
    expect(() => operation(app, runId, 'wait_for_events', {})).toThrow('requires');
    expect(() => operation(app, runId, 'wait_for_events', { run_ids: [runId] })).toThrow('your own completion');
  });

  it('persists main-only user questions and accepts an idempotent centralized reply', async () => {
    const { app, runId } = fixture(scripted(calls(call('ask_user', { question: 'Choose the accepted output marker' }, 'ask-marker')), async request => {
      expect(delivered(request).some(x => x.from === 'user' && x.kind === 'answer' && x.content === 'USER_MARKER')).toBe(true);
      return answer('User chose USER_MARKER');
    }));
    generous(app, runId);
    expect((await app.run(runId)).status).toBe('waiting');
    const sessionId = app.store.run(runId).sessionId;
    const query = app.coordinator.mailbox.userQuestions(sessionId)[0]!;
    expect(query).toMatchObject({ from: runId, to: 'user', content: 'Choose the accepted output marker' });
    app.answer(query.id, 'USER_MARKER');
    app.answer(query.id, 'USER_MARKER');
    expect(() => app.answer(query.id, 'DIFFERENT')).toThrow('different answer');
    expect(app.coordinator.mailbox.userQuestions(sessionId)).toHaveLength(0);
    expect((await app.run(runId)).status).toBe('completed');
    expect(app.store.messages(sessionId).filter(x => x.kind === 'answer')).toHaveLength(1);
  });
});

describe('wait resolution and shared execution limits', () => {
  it.each(['any', 'all'] as const)('detects a closed two-peer %s dependency cycle', mode => {
    const { app, runId } = fixture();
    const a = child(app, runId);
    const b = child(app, runId);
    const ab = question(app, a, b, 'ab');
    const ba = question(app, b, a, 'ba');
    received(app, a); received(app, b);
    const first = wait(app, a, { question_ids: [ab], mode });
    expect(first.status).toBe('registered');
    const second = wait(app, b, { question_ids: [ba], mode });
    expect(app.store.wait(first.id)).toMatchObject({ status: 'settled', reason: 'deadlock' });
    expect(app.store.wait(second.id)).toMatchObject({ status: 'settled', reason: 'deadlock' });
    expect(app.store.inbox(runId).some(x => x.content.includes('deadlock'))).toBe(true);
  });

  it.each([{ mode: 'any', blocked: false }, { mode: 'all', blocked: true }] as const)('evaluates an external exit according to $mode semantics', ({ mode, blocked }) => {
    const { app, runId } = fixture();
    const a = child(app, runId);
    const b = child(app, runId);
    const outside = child(app, runId);
    const ab = question(app, a, b, 'ab');
    const ac = question(app, a, outside, 'ac');
    const ba = question(app, b, a, 'ba');
    received(app, a); received(app, b);
    const first = wait(app, a, { question_ids: [ab, ac], mode });
    const second = wait(app, b, { question_ids: [ba] });
    expect(app.store.wait(first.id).status).toBe(blocked ? 'settled' : 'registered');
    expect(app.store.wait(second.id).status).toBe(blocked ? 'settled' : 'registered');
    if (!blocked) {
      operation(app, outside, 'send_message', { to: a, kind: 'answer', reply_to: ac, content: 'external answer' });
      expect(app.store.wait(first.id)).toMatchObject({ status: 'settled', reason: 'conditions_met' });
      expect(app.store.wait(second.id).status).toBe('registered');
    }
  });

  it('excludes an already answered question from all-wait deadlock dependencies', async () => {
    const { app, runId } = fixture();
    generous(app, runId);
    const a = child(app, runId);
    const b = child(app, runId);
    const outside = child(app, runId);
    const ab = question(app, a, b, 'answered-by-b');
    const ac = question(app, a, outside, 'awaiting-c');
    received(app, b);
    operation(app, b, 'send_message', { to: a, kind: 'answer', reply_to: ab, content: 'B already supplied evidence' });
    const waitingB = wait(app, b, { run_ids: [a] });
    const waitingA = wait(app, a, { question_ids: [ab, ac], mode: 'all' });
    expect(app.store.wait(waitingA.id).status).toBe('registered');
    expect(app.store.wait(waitingB.id).status).toBe('registered');
    expect(app.store.events(a).some(x => x.type === 'wait.deadlock')).toBe(false);
    expect(app.store.events(b).some(x => x.type === 'wait.deadlock')).toBe(false);
    operation(app, outside, 'send_message', { to: a, kind: 'answer', reply_to: ac, content: 'C completed the remaining evidence' });
    expect(app.store.wait(waitingA.id)).toMatchObject({ status: 'settled', reason: 'conditions_met' });
    expect((await app.coordinator.wake(a)).status).toBe('completed');
    expect(app.store.wait(waitingB.id)).toMatchObject({ status: 'settled', reason: 'conditions_met' });
  });

  it('detects a wait cycle through a queued continuation that requires its predecessor to end', () => {
    const { app, runId } = fixture();
    const continuation = app.submitInput(runId, 'Follow up after predecessor ends', { mode: 'follow_up' });
    expect(continuation).toMatchObject({ continuationOf: runId, status: 'queued' });
    const registration = wait(app, runId, { run_ids: [continuation.id] });
    expect(app.store.wait(registration.id)).toMatchObject({ status: 'settled', reason: 'deadlock' });
    expect(app.store.events(runId).find(x => x.type === 'wait.deadlock')?.data.runs).toEqual(expect.arrayContaining([runId, continuation.id]));
    expect(app.store.run(continuation.id).status).toBe('queued');
  });

  it('wakes on a new question without marking the original question answered', async () => {
    let original = '';
    const { app, runId } = fixture(scripted(async () => calls(call('wait_for_events', { question_ids: [original], mode: 'all' }, 'await-original')), async request => {
      expect(delivered(request).some(x => x.kind === 'question' && x.content.includes('urgent'))).toBe(true);
      return answer('Handled the new question separately');
    }));
    generous(app, runId);
    const peer = child(app, runId);
    original = question(app, runId, peer, 'original');
    expect((await app.coordinator.wake(runId)).status).toBe('waiting');
    const registration = app.store.waits().find(x => x.runId === runId)!;
    question(app, peer, runId, 'urgent');
    expect(app.store.wait(registration.id)).toMatchObject({ status: 'settled', reason: 'new_input' });
    expect(app.store.messages(app.store.run(runId).sessionId).some(x => x.kind === 'answer' && x.replyTo === original)).toBe(false);
    expect(app.store.message(original)?.kind).toBe('question');
    expect((await app.coordinator.wake(runId)).status).toBe('completed');
  });

  it('resolves an expired durable wait and supplies timeout evidence to the next model step', async () => {
    let peer = '';
    const { app, runId } = fixture(scripted(async () => calls(call('wait_for_events', { run_ids: [peer], timeout_ms: 50 }, 'deadline')), async request => {
      expect(delivered(request).some(x => x.kind === 'event' && x.content.includes('timeout'))).toBe(true);
      return answer('Deadline reported');
    }));
    generous(app, runId);
    peer = child(app, runId);
    expect((await app.coordinator.wake(runId)).status).toBe('waiting');
    const registration = app.store.waits().find(x => x.runId === runId)!;
    const now = vi.spyOn(Date, 'now').mockReturnValue(registration.deadline + 1);
    try {
      expect((await app.coordinator.wake(runId)).status).toBe('completed');
      expect(app.store.wait(registration.id)).toMatchObject({ status: 'settled', reason: 'timeout' });
    } finally { now.mockRestore(); }
  });

  it('drives a real wait deadline while a peer model remains in flight', async () => {
    let peer = '';
    const { app, runId } = fixture({ async complete(request, signal) {
      const run = requestRun(app, request);
      if (run.parentId) return await new Promise<ModelResponse>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
      });
      if (!run.step) return calls(call('wait_for_events', { run_ids: [peer], timeout_ms: 80 }, 'real-deadline'));
      expect(delivered(request).some(x => x.kind === 'event' && x.content.includes('timeout'))).toBe(true);
      return answer('Main reported a deadline while peer was busy');
    } });
    generous(app, runId);
    peer = child(app, runId);
    expect((await app.run(runId)).status).toBe('completed');
    expect(app.store.waits().find(x => x.runId === runId)).toMatchObject({ reason: 'timeout', status: 'settled' });
    expect(app.store.run(peer).status).toBe('cancelled');
    expect(app.store.calls(peer).filter(x => x.kind === 'model')).toHaveLength(1);
  });

  it('reports an ended peer explicitly instead of waiting for an impossible answer', () => {
    const { app, runId } = fixture();
    const peer = child(app, runId);
    const q = question(app, runId, peer);
    app.coordinator.cancel(peer);
    const registration = wait(app, runId, { question_ids: [q], mode: 'all' });
    expect(registration).toMatchObject({ status: 'settled', reason: 'conditions_met' });
    const evidence = app.store.inbox(runId).find(x => x.id === `wake:${registration.id}`)!;
    expect(JSON.parse(evidence.content)).toMatchObject({ details: [{ questionId: q, peerStatus: 'cancelled', ready: true }] });
  });

  it('enforces session creation counts even after children have terminated', () => {
    const { app, runId } = fixture();
    generous(app, runId, { maxChildren: 1 });
    const first = child(app, runId);
    app.coordinator.cancel(first);
    expect(() => child(app, runId, 'over budget')).toThrow('creation limit');
    expect(app.store.listRuns()).toHaveLength(2);
  });

  it('limits concurrent model slots and shares model-call accounting across peers', async () => {
    let active = 0;
    let peak = 0;
    const complete = vi.fn(async (): Promise<ModelResponse> => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
      return answer('completed independently');
    });
    const { app, runId } = fixture({ complete });
    generous(app, runId, { maxConcurrentModels: 1, maxModelCalls: 2 });
    const a = child(app, runId);
    const b = child(app, runId);
    const results = await Promise.all([app.coordinator.wake(a), app.coordinator.wake(b)]);
    expect(peak).toBe(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(results.map(x => x.status).sort()).toEqual(['completed', 'failed']);
    expect(results.find(x => x.status === 'failed')?.error).toContain('CHILD_BUDGET');
    expect(app.store.session(app.store.run(runId).sessionId)).toMatchObject({ modelCalls: 1, tokens: 80 });
  });

  it('serializes three independent peers through one model slot without losing queued work', async () => {
    let active = 0;
    let peak = 0;
    const complete = vi.fn(async (): Promise<ModelResponse> => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return answer('one slot used');
    });
    const { app, runId } = fixture({ complete });
    generous(app, runId, { maxConcurrentModels: 1 });
    const peers = [child(app, runId), child(app, runId), child(app, runId)];
    expect((await Promise.all(peers.map(id => app.coordinator.wake(id)))).map(x => x.status)).toEqual(['completed', 'completed', 'completed']);
    expect(peak).toBe(1);
    expect(complete).toHaveBeenCalledTimes(3);
    expect(app.store.session(app.store.run(runId).sessionId)).toMatchObject({ modelCalls: 3, tokens: 240 });
  });
});
