import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { Application } from '../src/application/index.js';
import { KodoError } from '../src/runtime/types.js';
import type { Provider } from '../src/runtime/types.js';
import { unlockData } from '../src/storage/index.js';
import { answer, call, calls, fixture, scripted, temp } from './helpers.js';

function mailbox(app: Application, runId: string, name: string, args: Record<string, unknown>, callId = name): Record<string, unknown> {
  return app.store.transaction(() => {
    const run = app.store.run(runId);
    return app.coordinator.mailbox.execute(run, callId, name, app.coordinator.mailbox.validate(run, name, JSON.stringify(args))) as Record<string, unknown>;
  });
}
function auditedRecovery(app: Application, sourceId: string): string {
  app.store.updateRun(sourceId, { status: 'failed', error: 'UNKNOWN_WRITE: simulated effect outcome not confirmed' });
  const next = app.submitInput(sourceId, 'Recovery fixture');
  app.store.transaction(() => {
    app.store.event(sourceId, 'recovery.continued', { runId: next.id });
    app.store.event(next.id, 'run.queued', { continuationOf: sourceId, reason: 'verified effect recovery; source terminal records remain immutable' });
  });
  return next.id;
}

describe('kernel design acceptance', () => {
  it('does not let a direct wake bypass the continuation predecessor gate', async () => {
    const complete = vi.fn(async () => answer());
    const { app, runId } = fixture({ complete });
    const continuation = app.submitInput(runId, 'A later task', { mode: 'follow_up' });
    const result = await app.coordinator.wake(continuation.id);
    expect(app.store.run(runId).status).toBe('queued');
    expect(result.status).toBe('queued');
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not duplicate an identical unresolved user question after a steer wakes main', async () => {
    const ask = calls(call('ask_user', { question: 'Which release label should be used?' }, 'ask'));
    const repeated = calls(call('ask_user', { question: '  Which release label\nshould be used?  ' }, 'ask'));
    const { app, runId } = fixture(scripted(ask, repeated, answer('Original question answered')));
    expect((await app.run(runId)).status).toBe('waiting');
    const sessionId = app.store.run(runId).sessionId;
    const original = app.coordinator.mailbox.userQuestions(sessionId)[0]!;
    app.submitInput(runId, 'The release is still for the same project.');
    expect((await app.run(runId)).status).toBe('waiting');
    expect(app.coordinator.mailbox.userQuestions(sessionId).map(x => x.id)).toEqual([original.id]);
    app.answer(original.id, 'release-v1');
    expect((await app.run(runId)).status).toBe('completed');
    expect(app.coordinator.mailbox.userQuestions(sessionId)).toHaveLength(0);
  });

  it('keeps distinct user questions separate and accepts both replies', async () => {
    const question = 'Which release label should be used?';
    const { app, runId } = fixture(scripted(
      calls(call('ask_user', { question }, 'first')),
      calls(call('ask_user', { question: 'Which output format should be used?' }, 'second')),
      answer('Both question answers received'),
    ));
    expect((await app.run(runId)).status).toBe('waiting');
    const sessionId = app.store.run(runId).sessionId;
    const original = app.coordinator.mailbox.userQuestions(sessionId)[0]!;
    app.submitInput(runId, 'A separate output format decision is also needed.');
    expect((await app.run(runId)).status).toBe('waiting');
    const questions = app.coordinator.mailbox.userQuestions(sessionId);
    expect(questions).toHaveLength(2);
    app.answer(original.id, 'release-v1');
    app.answer(questions.find(x => x.id !== original.id)!.id, 'JSON');
    expect((await app.run(runId)).status).toBe('completed');
    expect(app.coordinator.mailbox.userQuestions(sessionId)).toHaveLength(0);
  });

  it('creates a new question when the same text was already answered', async () => {
    const ask = calls(call('ask_user', { question: 'Which release label should be used?' }, 'ask'));
    const { app, runId } = fixture(scripted(ask, ask));
    expect((await app.run(runId)).status).toBe('waiting');
    const sessionId = app.store.run(runId).sessionId;
    const original = app.coordinator.mailbox.userQuestions(sessionId)[0]!;
    app.answer(original.id, 'release-v1');
    expect((await app.run(runId)).status).toBe('waiting');
    const outstanding = app.coordinator.mailbox.userQuestions(sessionId);
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]!.id).not.toBe(original.id);
    expect(app.store.messages(sessionId).filter(x => x.kind === 'question')).toHaveLength(2);
  });

  it('retries a transient model failure with its original snapshot and delivers later input once', async () => {
    let count = 0;
    const requests: Parameters<Provider['complete']>[0][] = [];
    const { app, runId } = fixture({ async complete(request) {
      requests.push(request);
      if (++count === 1) {
        app.submitInput(runId, 'STEER_AFTER_REQUEST_STARTED');
        throw new KodoError('MODEL_RATE_LIMIT', 'temporary rate limit');
      }
      return answer(count === 2 ? 'original request recovered' : 'new input handled');
    } });
    const result = await app.run(runId);
    expect(result.status).toBe('completed');
    expect(requests).toHaveLength(3);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2]!.messages.filter(x => x.content?.includes('STEER_AFTER_REQUEST_STARTED'))).toHaveLength(1);
    const modelCalls = app.store.calls(runId).filter(x => x.kind === 'model');
    expect(modelCalls).toHaveLength(3);
    expect(modelCalls[0]!.requestRef).toBe(modelCalls[1]!.requestRef);
    expect(app.store.session(result.sessionId)).toMatchObject({ modelCalls: 3, usageEstimated: true });
  });

  it('retains elapsed shared execution time after a process dies inside its first model request', async () => {
    const directory = path.join(temp(), 'data');
    const applicationURL = pathToFileURL(path.resolve('dist/application/index.js')).href;
    const source = `
      import { Application } from ${JSON.stringify(applicationURL)};
      import process from 'node:process';
      const app = new Application(process.argv[1], { async complete() {
        process.stdout.write('ENTERED\\n');
        return await new Promise(() => {});
      } });
      const run = app.createRun({ objective: 'Hold the first model request', workspace: process.argv[1],
        binding: { model: 'test', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'UNUSED', limits: { context: 256000, output: 8192 } },
        budget: { maxDurationMs: 10000 } });
      await app.run(run.id);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, directory], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    let errors = '';
    child.stderr.on('data', chunk => { errors += String(chunk); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`child did not enter provider: ${errors}`)), 5000);
        child.stdout.on('data', chunk => {
          output += String(chunk);
          if (output.includes('ENTERED')) { clearTimeout(timeout); resolve(); }
        });
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', () => { if (!output.includes('ENTERED')) { clearTimeout(timeout); reject(new Error(`child exited: ${errors}`)); } });
      });
      await delay(150);
    } finally {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    unlockData(directory);
    const reopened = new Application(directory, scripted(answer()));
    try {
      const run = reopened.store.listRuns()[0]!;
      expect(run.status).toBe('interrupted');
      expect(reopened.store.session(run.sessionId).activeMs ?? 0).toBeGreaterThanOrEqual(100);
    } finally { reopened.close(); }
  }, 10000);

  it('keeps a cancelled run record immutable when the cancelled model returns late', async () => {
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { finish = resolve; });
    const { app, runId } = fixture({ async complete() { entered(); await released; return calls(call('file.list', { path: '.' })); } });
    const pending = app.coordinator.wake(runId);
    await started;
    app.coordinator.cancel(runId);
    const terminalRecord = app.store.run(runId);
    finish();
    await pending;
    expect(app.store.run(runId)).toEqual(terminalRecord);
    expect(app.store.events(runId).filter(x => x.type === 'tool.started')).toHaveLength(0);
  });

  it('protects the next main response when children request the last shared call slots during main inference', async () => {
    let started!: () => void;
    let release!: () => void;
    let mainCalls = 0;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const peers: string[] = [];
    const { app, runId } = fixture({ async complete(request) {
      if (request.messages[0]!.content!.includes('You are a child')) return answer('child result');
      if (++mainCalls === 1) { started(); await held; return calls(call('wait_for_events', { run_ids: peers, mode: 'all' })); }
      return answer('main reported results and the child budget limit');
    } });
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, maxModelCalls: 3, maxConcurrentModels: 3, maxTokens: 200_000 } });
    for (const objective of ['child A', 'child B']) {
      const spawned = app.store.transaction(() => app.coordinator.mailbox.execute(app.store.run(runId), objective, 'spawn_agent', { objective })) as { id: string };
      peers.push(spawned.id);
    }
    const main = app.coordinator.wake(runId);
    await entered;
    const children = await Promise.all(peers.map(id => app.coordinator.wake(id)));
    release();
    expect((await main).status).toBe('completed');
    expect(children.map(x => x.status).sort()).toEqual(['completed', 'failed']);
    expect(app.store.session(session.id).modelCalls).toBe(3);
  });

  it('reuses a crashed continuation request snapshot before consuming newly submitted steer input', async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let invocation = 0;
    let snapshot!: Parameters<Provider['complete']>[0];
    const { app, runId } = fixture({ async complete(request, signal) {
      if (++invocation === 1) return answer('ORIGINAL_TERMINAL_EVIDENCE');
      snapshot = request;
      entered();
      return await new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { reject(signal.reason); }, { once: true }); });
    } });
    expect((await app.run(runId)).status).toBe('completed');
    const original = app.store.run(runId);
    const continuation = app.submitInput(runId, 'Continue reviewing the prior evidence');
    const pending = app.run(continuation.id);
    await started;
    const directory = path.join(temp(), 'crash-image');
    mkdirSync(directory);
    // SQLite backup plus immutable blobs captures a real in-flight model request without
    // mutating its committed state or leaving an intentionally hung test runtime behind.
    await app.store.db.backup(path.join(directory, 'kodo.sqlite'));
    cpSync(path.join(app.store.directory, 'blobs'), path.join(directory, 'blobs'), { recursive: true });
    app.coordinator.cancel(continuation.id);
    await pending;
    const replayed: Parameters<Provider['complete']>[0][] = [];
    const reopened = new Application(directory, { async complete(request) { replayed.push(request); return answer('Continuation processed'); } });
    try {
      expect(reopened.store.run(continuation.id).status).toBe('interrupted');
      reopened.submitInput(continuation.id, 'STEER_AFTER_PROCESS_CRASH');
      expect((await reopened.recover(continuation.id)).status).toBe('completed');
      expect(replayed).toHaveLength(2);
      expect(replayed[0]).toEqual(snapshot);
      expect(replayed[0]!.messages.some(x => x.content?.includes('STEER_AFTER_PROCESS_CRASH'))).toBe(false);
      expect(replayed[1]!.messages.filter(x => x.content?.includes('STEER_AFTER_PROCESS_CRASH'))).toHaveLength(1);
      for (const request of replayed) expect(request.messages.filter(x => x.content?.startsWith(`Previous run ${runId}:`))).toHaveLength(1);
      expect(reopened.store.run(runId)).toEqual(original);
    } finally { await reopened.shutdown(); }
  });

  it('freezes later peer writes when cancellation leaves a late write result unknown without changing its terminal run', async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const { app, root, runId } = fixture({ async complete() { return calls(call('file.apply_patch', { path: 'after-uncertain.txt', expectedHash: null, content: 'must not write' })); } });
    const peers = ['writer A', 'writer B'].map(objective => (app.store.transaction(() => app.coordinator.mailbox.execute(app.store.run(runId), objective, 'spawn_agent', { objective })) as { id: string }).id);
    const execute = app.coordinator.tools.execute.bind(app.coordinator.tools);
    vi.spyOn(app.coordinator.tools, 'execute').mockImplementation(async (id, ...args) => {
      if (id !== peers[0]) return await execute(id, ...args);
      args[3]?.();
      entered();
      await held;
      return { path: 'potential-external-effect.txt', bytes: 5 };
    });
    const first = app.coordinator.wake(peers[0]!);
    await started;
    app.coordinator.cancel(peers[0]!);
    const terminalRecord = app.store.run(peers[0]!);
    release();
    await first;
    expect(app.store.run(peers[0]!)).toEqual(terminalRecord);
    expect(app.store.calls(peers[0]!).find(x => x.kind === 'tool')?.status).toBe('unknown');
    try { await app.coordinator.wake(peers[1]!); } catch (error) { expect(error).toBeInstanceOf(KodoError); }
    expect(existsSync(path.join(root, 'after-uncertain.txt'))).toBe(false);
    expect(app.store.events(peers[1]!).filter(x => x.type === 'tool.started')).toHaveLength(0);
  });

  it('freezes an already active peer before its model can start a write after another cancelled write becomes unknown', async () => {
    let writerEntered!: () => void;
    let modelEntered!: () => void;
    let releaseWriter!: () => void;
    let releaseModel!: () => void;
    const writing = new Promise<void>(resolve => { writerEntered = resolve; });
    const inferring = new Promise<void>(resolve => { modelEntered = resolve; });
    const writerHeld = new Promise<void>(resolve => { releaseWriter = resolve; });
    const modelHeld = new Promise<void>(resolve => { releaseModel = resolve; });
    let peerId = '';
    const { app, root, runId } = fixture({ async complete(request) {
      if (request.messages[0]!.content!.includes(peerId)) { modelEntered(); await modelHeld; }
      return calls(call('file.apply_patch', { path: 'active-peer.txt', expectedHash: null, content: 'must not write' }));
    } });
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, maxTokens: 200_000 } });
    const peers = ['writer A', 'writer B'].map(objective => (app.store.transaction(() => app.coordinator.mailbox.execute(app.store.run(runId), objective, 'spawn_agent', { objective })) as { id: string }).id);
    peerId = peers[1]!;
    const execute = app.coordinator.tools.execute.bind(app.coordinator.tools);
    vi.spyOn(app.coordinator.tools, 'execute').mockImplementation(async (id, ...args) => {
      if (id !== peers[0]) return await execute(id, ...args);
      args[3]?.();
      writerEntered();
      await writerHeld;
      return { path: 'potential-external-effect.txt', bytes: 5 };
    });
    const first = app.coordinator.wake(peers[0]!);
    await writing;
    const second = app.coordinator.wake(peerId);
    await inferring;
    app.coordinator.cancel(peers[0]!);
    releaseWriter();
    await first;
    releaseModel();
    await second;
    expect(existsSync(path.join(root, 'active-peer.txt'))).toBe(false);
    expect(app.store.events(peerId).filter(x => x.type === 'tool.started')).toHaveLength(0);
    expect(app.store.run(peerId).status).toBe('interrupted');
  });

  it('routes peer replies and inherited questions only across an audited recovery mailbox', () => {
    const { app, runId } = fixture();
    const peer = mailbox(app, runId, 'spawn_agent', { objective: 'peer with old questions' }).id as string;
    const outgoing = mailbox(app, runId, 'send_message', { to: peer, kind: 'question', content: 'Please supply evidence' }, 'outgoing').id as string;
    const incoming = mailbox(app, peer, 'send_message', { to: runId, kind: 'question', content: 'Please clarify acceptance' }, 'incoming').id as string;
    mailbox(app, runId, 'ask_user', { question: 'Which label?' });
    const oldUserQuestion = app.coordinator.mailbox.userQuestions(app.store.run(runId).sessionId)[0]!;
    const recovered = auditedRecovery(app, runId);
    const source = app.store.run(runId);
    expect(app.coordinator.mailbox.recoveryTarget(source).id).toBe(recovered);
    const reply = mailbox(app, peer, 'send_message', { to: runId, kind: 'answer', reply_to: outgoing, content: 'Peer evidence supplied' }, 'reply');
    expect(reply).toMatchObject({ delivered: true, routed_from: runId, to: recovered });
    expect(app.store.message(reply.id as string)).toMatchObject({ from: peer, to: recovered, replyTo: outgoing });
    const visible = mailbox(app, recovered, 'list_agents', {}).open_questions as { id: string }[];
    expect(visible.map(x => x.id)).toEqual(expect.arrayContaining([incoming, oldUserQuestion.id]));
    mailbox(app, recovered, 'send_message', { to: peer, kind: 'answer', reply_to: incoming, content: 'New main clarified acceptance' }, 'recovered-answer');
    const wait = mailbox(app, recovered, 'wait_for_events', { question_ids: [outgoing] });
    expect(app.store.wait(wait.waitId as string)).toMatchObject({ status: 'settled', reason: 'conditions_met' });
    expect(app.coordinator.mailbox.userQuestions(source.sessionId).map(x => x.id)).toContain(oldUserQuestion.id);
    expect(() => mailbox(app, recovered, 'wait_for_events', { run_ids: [runId] })).toThrow('own completion');
    expect(app.store.run(runId)).toEqual(source);
  });

  it('does not expose or transfer predecessor questions to an ordinary follow-up', () => {
    const { app, runId } = fixture();
    const peer = mailbox(app, runId, 'spawn_agent', { objective: 'peer' }).id as string;
    const outgoing = mailbox(app, runId, 'send_message', { to: peer, kind: 'question', content: 'Old request' }, 'old-request').id as string;
    const incoming = mailbox(app, peer, 'send_message', { to: runId, kind: 'question', content: 'Old peer question' }, 'old-question').id as string;
    app.store.updateRun(runId, { status: 'completed', resultRef: app.store.blob({ text: 'Old main completed' }) });
    const followUp = app.submitInput(runId, 'Ordinary new task');
    expect(app.coordinator.mailbox.recoveryTarget(app.store.run(runId)).id).toBe(runId);
    expect(mailbox(app, peer, 'send_message', { to: runId, kind: 'notice', content: 'Late message' })).toMatchObject({ delivered: false, target_status: 'completed' });
    expect(mailbox(app, followUp.id, 'list_agents', {}).open_questions).toEqual([]);
    expect(() => mailbox(app, followUp.id, 'send_message', { to: peer, kind: 'answer', reply_to: incoming, content: 'Must not inherit' })).toThrow('addressed to this sender');
    expect(() => mailbox(app, followUp.id, 'wait_for_events', { question_ids: [outgoing] })).toThrow('your own questions');
  });

  it('requires both sides of the same-session recovery audit and follows the latest audited successor', () => {
    const { app, runId } = fixture();
    const first = auditedRecovery(app, runId);
    const latest = auditedRecovery(app, first);
    const peer = mailbox(app, latest, 'spawn_agent', { objective: 'peer' }).id as string;
    const sent = mailbox(app, peer, 'send_message', { to: runId, kind: 'notice', content: 'Route through two verified recoveries' });
    expect(app.store.message(sent.id as string)?.to).toBe(latest);
    const source = app.store.run(latest);
    app.store.updateRun(latest, { status: 'failed', error: 'UNKNOWN_WRITE: fixture' });
    const unaudited = app.submitInput(latest, 'Not an audited recovery');
    app.store.event(latest, 'recovery.continued', { runId: unaudited.id });
    expect(app.coordinator.mailbox.recoveryTarget(app.store.run(latest)).id).toBe(source.id);
  });

  it('pauses shared execution time while the session durably waits for its user', async () => {
    const { app, runId } = fixture(scripted(calls(call('ask_user', { question: 'Choose release label' })), answer('User selected a label')));
    expect((await app.run(runId)).status).toBe('waiting');
    const sessionId = app.store.run(runId).sessionId;
    const before = app.store.session(sessionId);
    expect(before.activeSince).toBeUndefined();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);
    try {
      const question = app.coordinator.mailbox.userQuestions(sessionId)[0]!;
      app.answer(question.id, 'release-v1');
      expect((await app.run(runId)).status).toBe('completed');
      expect(app.store.session(sessionId).activeMs).toBe(before.activeMs);
    } finally { clock.mockRestore(); }
  });

  it('keeps paused active peers resumable when the session driver observes an uncertain child effect', async () => {
    let peerId = '';
    let uncertainId = '';
    let mainId = '';
    let peerEntered!: () => void;
    let releasePeer!: () => void;
    let mainPaused!: () => void;
    const entering = new Promise<void>(resolve => { peerEntered = resolve; });
    const held = new Promise<void>(resolve => { releasePeer = resolve; });
    const paused = new Promise<void>(resolve => { mainPaused = resolve; });
    const { app, runId } = fixture({ async complete(request) {
      const identity = request.messages[0]!.content!;
      if (identity.includes(peerId)) { peerEntered(); await held; return answer('late peer response'); }
      if (identity.includes(uncertainId)) return calls(call('file.apply_patch', { path: 'uncertain.txt', expectedHash: null, content: 'uncertain' }));
      return calls(call('wait_for_events', { run_ids: [peerId, uncertainId], mode: 'all' }));
    } });
    mainId = runId;
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, maxTokens: 200_000 } });
    uncertainId = mailbox(app, mainId, 'spawn_agent', { objective: 'uncertain writer' }, 'spawn-writer').id as string;
    peerId = mailbox(app, mainId, 'spawn_agent', { objective: 'active peer' }, 'spawn-peer').id as string;
    const off = app.store.subscribe(event => { if (event.runId === mainId && event.type === 'run.interrupted') mainPaused(); });
    vi.spyOn(app.coordinator.tools, 'execute').mockImplementation(async (_id, _name, _args, _signal, onEffectStart) => { await entering; onEffectStart?.(); throw new Error('uncertain external effect'); });
    const driving = app.run(mainId);
    try {
      await paused;
      await delay(0);
    } finally { releasePeer(); off(); }
    const result = await driving;
    expect(result.status).toBe('interrupted');
    expect(app.store.run(peerId).status).toBe('interrupted');
    expect(app.store.run(uncertainId).status).toBe('failed');
    expect(app.store.events(peerId).filter(x => x.type === 'run.cancelled')).toHaveLength(0);
  });

  it('does not let a new session write the same project while another session has an unreconciled effect', async () => {
    const { app, root, runId } = fixture(scripted(calls(call('file.apply_patch', { path: 'other-session.txt', expectedHash: null, content: 'must remain blocked' })), answer('write complete')));
    const source = app.store.run(runId);
    app.store.putCall({ id: 'unknown-project-write', runId, step: 0, kind: 'tool', name: 'process.exec', effect: 'write', status: 'unknown', requestRef: app.store.blob(call('process.exec', { program: 'external', args: [] })), reservedTokens: 0 });
    app.store.updateRun(runId, { status: 'interrupted' });
    const other = app.createRun({ objective: 'Write in the same affected project', workspace: root, binding: source.binding, permissions: ['read', 'write'] });
    try { await app.run(other.id); } catch (error) { expect(error).toBeInstanceOf(KodoError); }
    expect(existsSync(path.join(root, 'other-session.txt'))).toBe(false);
    expect(app.store.events(other.id).filter(x => x.type === 'tool.started')).toHaveLength(0);
  });

  it('allows another session to read the affected project while an unresolved effect blocks its writes', async () => {
    const { app, root, runId } = fixture(scripted(calls(call('file.list', { path: '.' })), answer('Read-only investigation completed')));
    const source = app.store.run(runId);
    app.store.putCall({ id: 'unknown-project-read-boundary', runId, step: 0, kind: 'tool', name: 'process.exec', effect: 'write', status: 'unknown', requestRef: app.store.blob(call('process.exec', { program: 'external', args: [] })), reservedTokens: 0 });
    app.store.updateRun(runId, { status: 'interrupted' });
    const other = app.createRun({ objective: 'Inspect the affected project without writing', workspace: root, binding: source.binding });
    expect((await app.run(other.id)).status).toBe('completed');
    expect(app.store.calls(other.id).find(x => x.kind === 'tool')).toMatchObject({ name: 'file.list', status: 'succeeded' });
  });

  it.each(['unrelated', 'nested-target', 'nested-source'] as const)('scopes the unresolved effect barrier by overlapping workspace: %s', async scenario => {
    const { app, root, runId } = fixture(scripted(calls(call('file.apply_patch', { path: 'workspace-boundary.txt', expectedHash: null, content: 'allowed only outside affected workspaces' })), answer('Written')));
    const source = app.store.run(runId);
    const nested = path.join(root, 'nested');
    mkdirSync(nested);
    const unrelated = temp();
    const sourceSession = app.store.session(source.sessionId);
    if (scenario === 'nested-source') app.store.putSession({ ...sourceSession, workspace: nested });
    app.store.putCall({ id: `unknown-project-${scenario}`, runId, step: 0, kind: 'tool', name: 'process.exec', effect: 'write', status: 'unknown', requestRef: app.store.blob(call('process.exec', { program: 'external', args: [] })), reservedTokens: 0 });
    app.store.updateRun(runId, { status: 'interrupted' });
    const workspace = scenario === 'unrelated' ? unrelated : scenario === 'nested-target' ? nested : root;
    const other = app.createRun({ objective: 'Exercise the project write boundary', workspace, binding: source.binding, permissions: ['read', 'write'] });
    try { await app.run(other.id); } catch (error) { expect(error).toBeInstanceOf(KodoError); }
    expect(existsSync(path.join(workspace, 'workspace-boundary.txt'))).toBe(scenario === 'unrelated');
    if (scenario === 'unrelated') expect(app.store.run(other.id).status).toBe('completed');
    else expect(app.store.events(other.id).filter(x => x.type === 'tool.started')).toHaveLength(0);
  });

  it('accepts the original user question after real audited effect recovery without creating a second question', async () => {
    let mainCalls = 0;
    const { app, runId } = fixture({ async complete() {
      return ++mainCalls === 1
        ? calls(call('ask_user', { question: 'Which release label survives recovery?' }, 'recovered-question'))
        : answer('Recovered main accepted the original user answer');
    } });
    mailbox(app, runId, 'ask_user', { question: 'Which release label survives recovery?' }, 'original-question');
    const originalQuestion = app.coordinator.mailbox.userQuestions(app.store.run(runId).sessionId)[0]!;
    const request = call('file.apply_patch', { path: 'recovered.txt', expectedHash: null, content: 'safe retry after verification' }, 'verified-write');
    const modelId = 'model-before-question-recovery';
    app.store.putCall({ id: modelId, runId, step: 0, kind: 'model', name: 'fixture', status: 'succeeded', effect: 'read', requestRef: app.store.blob({}), resultRef: app.store.blob(calls(request)), reservedTokens: 0 });
    app.store.putCall({ id: `${modelId}:${request.id}`, runId, step: 0, kind: 'tool', name: request.name, effect: 'write', status: 'unknown', requestRef: app.store.blob(request), reservedTokens: 0 });
    app.store.updateRun(runId, { status: 'failed', stepCallId: modelId, error: 'UNKNOWN_WRITE: outcome requires verification' });
    const source = app.store.run(runId);
    await app.reconcile(runId);
    const recovered = await app.recover(runId);
    expect(recovered.status).toBe('waiting');
    expect(recovered.id).not.toBe(runId);
    expect(app.coordinator.mailbox.userQuestions(source.sessionId).map(x => x.id)).toEqual([originalQuestion.id]);
    expect(app.answer(originalQuestion.id, 'release-v1').id).toBe(recovered.id);
    expect(app.store.messages(source.sessionId).find(x => x.replyTo === originalQuestion.id && x.kind === 'answer')).toMatchObject({ to: recovered.id, content: 'release-v1' });
    expect((await app.run(recovered.id)).status).toBe('completed');
    expect(app.store.run(runId)).toEqual(source);
    expect(app.store.messages(source.sessionId).filter(x => x.kind === 'question' && x.to === 'user')).toHaveLength(1);
  });
});
