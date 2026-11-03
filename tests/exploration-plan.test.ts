import { storageTestConnection } from '../src/storage/test-access.js';
import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { Application } from '../src/application/index.js';
import { Mailbox } from '../src/messaging/index.js';
import { Store } from '../src/storage/index.js';
import type { Message, Provider, Run } from '../src/runtime/types.js';
import { answer, binding, call, calls, fixture, scripted, temp } from './helpers.js';

const question = (id = 'storage') => ({ id, question: 'Which storage invariants must remain compatible?', inputs: ['src/storage.ts'], consumer: 'Storage implementation', deliverable: 'Source-backed compatibility constraints and unknowns', execution: 'child', reason: 'Independent source investigation while main handles UI', read_scope: ['src'], knowledge_refs: [] });
const plan = (...questions: Record<string, unknown>[]) => ({ batch_id: 'storage-ui', decision_version: 0, questions: questions.length ? questions : [question()] });
function submit(mailbox: Mailbox, run: Run, args: Record<string, unknown>): { replayed: boolean; questions: { question_id: string; run_id?: string; execution: string }[] } {
  return mailbox.execute(run, 'plan-call', 'exploration.plan', mailbox.validate(run, 'exploration.plan', JSON.stringify(args))) as ReturnType<typeof submit>;
}
function setup() {
  const { app, runId } = fixture();
  const mailbox = new Mailbox(app.store, () => undefined, { exploration: true });
  return { app, mailbox, run: app.store.run(runId) };
}

describe('host-enabled exploration dispatch', () => {
  it('honors host opt-out, hides structured planning by default, and forbids children', () => {
    const { app, mailbox, run } = setup();
    const disabled = new Mailbox(app.store, () => undefined, { exploration: false });
    expect(app.coordinator.mailbox.specs(run).some(spec => spec.name === 'exploration.plan')).toBe(false);
    expect(app.coordinator.mailbox.specs(run).filter(spec => spec.name === 'explore' || spec.name === 'spawn_agent').map(spec => spec.name)).toEqual(['explore', 'spawn_agent']);
    const structured = new Application(path.join(temp(), '.state'), scripted(answer()), undefined, { structuredExploration: true, agentFactors: { D: false, E: false, B: false } });
    try { expect(structured.coordinator.mailbox.specs(structured.createRun({ objective: 'Plan', workspace: temp(), binding })).some(spec => spec.name === 'exploration.plan')).toBe(true); }
    finally { structured.close(); }
    expect(disabled.specs(run).some(spec => spec.name === 'exploration.plan')).toBe(false);
    expect(() => disabled.execute(run, 'bypass', 'exploration.plan', plan())).toThrow(/host enablement/);
    const created = submit(mailbox, run, plan());
    const child = app.store.run(created.questions[0]!.run_id!);
    expect(mailbox.specs(child).some(spec => spec.name === 'exploration.plan')).toBe(false);
    expect(() => submit(mailbox, child, plan())).toThrow(/not available to a child/);
  });

  it('dispatches only ready child questions and narrows inherited tools, skills and permissions', async () => {
    const { app, mailbox, run } = setup();
    app.store.updateRun(run.id, { card: { ...run.card, tools: ['file.read', 'file.list', 'file.search', 'process.exec', 'shell.exec', 'file.patch', 'web.search', 'mcp.private', 'skill.load'], skills: ['private-skill'] } });
    const current = app.store.run(run.id);
    const result = submit(mailbox, current, plan(
      question(),
      { ...question('ui'), execution: 'main' },
      { ...question('validation'), execution: 'deferred', dependencies: ['storage'] },
    ));
    expect(result.questions.map(item => item.execution)).toEqual(['child', 'main', 'deferred']);
    const children = app.store.listRuns(run.sessionId).filter(item => item.parentId);
    expect(children).toHaveLength(1);
    const child = children[0]!;
    expect(child).toMatchObject({ permissions: ['read'], scope: { read: ['src'], write: [] }, exploration: { questionId: 'storage', batchId: 'storage-ui', decisionVersion: 0, consumer: 'Storage implementation', knowledgeRefs: [] } });
    // Children inherit the parent card and its tools; permissions are narrowed by the caller.
    expect(child.card.digest).toBe(app.store.run(run.id).card.digest);
    expect(child.card.tools).toEqual(app.store.run(run.id).card.tools);
    expect(child.card.skills).toEqual(app.store.run(run.id).card.skills);
    for (const name of ['process.exec', 'shell.exec', 'file.patch', 'web.search', 'mcp.private', 'skill.load']) {
      await expect(app.coordinator.tools.execute(child.id, name, {}, new AbortController().signal)).rejects.toThrow(/not authorized/);
    }
    const context = app.store.readBlob<Message[]>(child.contextRef);
    expect(JSON.stringify(context)).toContain('Exploration result contract');
    expect(JSON.stringify(context)).toContain('inspect_run');
  });

  it('prevalidates the whole batch and leaves no partial assignment for a removed card selector', () => {
    const { app, mailbox, run } = setup();
    expect(() => submit(mailbox, run, plan(question(), { ...question('bad'), card_id: 'absent', card_version: '1.0.0' }))).toThrow(/arguments do not match/);
    expect(app.store.listRuns(run.sessionId)).toHaveLength(1);
    expect(app.store.events(run.id).filter(event => event.type === 'exploration.planned')).toHaveLength(0);
    expect(submit(mailbox, run, plan()).questions[0]!.run_id).toBeTruthy();
  });

  it('rolls back an actual mid-commit failure, publishes no queued events, and retries once', () => {
    const { app, mailbox, run } = setup();
    const delivered: string[] = [];
    const off = app.store.subscribe(event => delivered.push(event.type));
    const original = app.store.event.bind(app.store);
    let queued = 0;
    const fault = vi.spyOn(app.store, 'event').mockImplementation((...args) => {
      if (args[1] === 'run.queued' && ++queued === 2) throw new Error('simulated interrupted batch commit');
      return original(...args);
    });
    const args = plan(question('storage'), question('api'));
    try {
      expect(() => submit(mailbox, run, args)).toThrow(/simulated interrupted batch commit/);
      expect(app.store.listRuns(run.sessionId)).toHaveLength(1);
      expect(app.store.events(run.id).some(event => event.type === 'exploration.planned')).toBe(false);
      expect(delivered).toEqual([]);
    } finally { fault.mockRestore(); off(); }
    const result = submit(mailbox, run, args);
    expect(result.questions.filter(item => item.run_id)).toHaveLength(2);
    expect(app.store.listRuns(run.sessionId)).toHaveLength(3);
    expect(submit(mailbox, run, args).questions).toEqual(result.questions);
    expect(app.store.listRuns(run.sessionId)).toHaveLength(3);
  });

  it('replays the exact persisted mapping after closing and reopening the store', () => {
    const { app, mailbox, run } = setup();
    const args = plan();
    const first = submit(mailbox, run, args);
    const directory = app.store.directory;
    app.close();
    const reopened = new Store(directory);
    try {
      const recovered = new Mailbox(reopened, () => undefined, { exploration: true });
      const again = submit(recovered, reopened.run(run.id), { questions: args.questions, decision_version: 0, batch_id: 'storage-ui' });
      expect(again.replayed).toBe(true);
      expect(again.questions).toEqual(first.questions);
      expect(reopened.listRuns(run.sessionId)).toHaveLength(2);
      expect(reopened.events(run.id).filter(event => event.type === 'exploration.planned')).toHaveLength(1);
    } finally { reopened.close(); }
  });

  it('rejects reused batches with changed content, duplicate question IDs and stale decisions', () => {
    const { app, mailbox, run } = setup();
    submit(mailbox, run, plan());
    expect(() => submit(mailbox, run, plan({ ...question(), consumer: 'Changed consumer' }))).toThrow(/different exploration content/);
    expect(() => submit(mailbox, run, { ...plan(), batch_id: 'another-batch' })).toThrow(/already has an execution decision/);
    const session = app.store.session(run.sessionId);
    app.store.putSession({ ...session, decisionVersion: 1 });
    expect(() => submit(mailbox, run, { ...plan(question('new')), batch_id: 'new' })).toThrow(/decision_version/);
    expect(app.store.listRuns(run.sessionId)).toHaveLength(2);
  });

  it.each([
    { name: 'not ready', args: plan({ ...question(), dependencies: ['other'] }), error: /no unresolved dependencies/ },
    { name: 'unscoped', args: plan({ ...question(), read_scope: [] }), error: /nonempty read_scope/ },
    { name: 'missing input', args: plan({ ...question(), inputs: [] }), error: /concrete inputs/ },
    { name: 'unexplained deferral', args: plan({ ...question(), execution: 'deferred' }), error: /missing-input explanation/ },
    { name: 'missing reuse version', args: plan({ ...question(), execution: 'reuse' }), error: /exact knowledge/ },
    { name: 'unknown dependency', args: plan({ ...question(), execution: 'deferred', dependencies: ['unknown'] }), error: /reference other/ },
    { name: 'duplicate ID', args: plan(question(), question()), error: /unique within a batch/ },
    { name: 'too many questions', args: plan(...Array.from({ length: 5 }, (_, index) => question(`q${index}`))), error: /schema/ },
  ])('rejects $name without creating a child', ({ args, error }) => {
    const { app, mailbox, run } = setup();
    expect(() => submit(mailbox, run, args)).toThrow(error);
    expect(app.store.listRuns(run.sessionId)).toHaveLength(1);
  });

  it('enforces the cumulative creation budget across the whole batch', () => {
    const { app, mailbox, run } = setup();
    const session = app.store.session(run.sessionId);
    app.store.putSession({ ...session, budget: { ...session.budget, maxChildren: 1 } });
    expect(() => submit(mailbox, run, plan(question(), question('api')))).toThrow(/child creation limit/);
    expect(app.store.listRuns(run.sessionId)).toHaveLength(1);
    submit(mailbox, run, plan());
    expect(submit(mailbox, run, plan()).replayed).toBe(true);
  });

  it.each(['models', 'tokens', 'duration'])('rejects dispatch after the shared %s budget is exhausted', kind => {
    const { app, mailbox, run } = setup();
    const session = app.store.session(run.sessionId);
    app.store.putSession({ ...session, modelCalls: kind === 'models' ? 1 : 0, tokens: kind === 'tokens' ? 1 : 0, activeMs: kind === 'duration' ? 1 : 0, budget: { ...session.budget, maxModelCalls: 1, maxTokens: 1, maxDurationMs: 1 } });
    expect(() => submit(mailbox, run, plan())).toThrow(/exhausted shared/);
    expect(app.store.listRuns(run.sessionId)).toHaveLength(1);
  });

  it('dispatches a previously deferred question once it is ready while preserving its identity', () => {
    const { app, mailbox, run } = setup();
    submit(mailbox, run, plan({ ...question(), execution: 'deferred', blocked_reason: 'Await confirmed entry point' }));
    expect(app.store.listRuns(run.sessionId)).toHaveLength(1);
    expect(() => submit(mailbox, run, { ...plan({ ...question(), question: 'Different investigation' }), batch_id: 'ready' })).toThrow(/preserve its question/);
    const dispatched = submit(mailbox, run, { ...plan(), batch_id: 'ready' });
    expect(dispatched.questions[0]!.run_id).toBeTruthy();
    expect(() => submit(mailbox, run, { ...plan(), batch_id: 'again' })).toThrow(/already has an execution decision/);
    expect(app.store.listRuns(run.sessionId)).toHaveLength(2);
  });

  it('rejects unauthorized scopes and missing read grants before dispatch', () => {
    const { app, mailbox, run } = setup();
    app.store.updateRun(run.id, { scope: { read: ['docs'], write: [] } });
    expect(() => submit(mailbox, app.store.run(run.id), plan())).toThrow(/contained/);
    app.store.updateRun(run.id, { scope: {}, permissions: [] });
    expect(() => submit(mailbox, app.store.run(run.id), plan())).toThrow(/subset/);
    // The removed read-only card view no longer refuses card tools here: children
    // inherit the parent card and the read-only permission subset is enforced.
    app.store.updateRun(run.id, { permissions: ['read'], card: { ...run.card, tools: ['process.run'] } });
    const dispatched = submit(mailbox, app.store.run(run.id), plan());
    expect(dispatched.questions[0]!.run_id).toBeTruthy();
    expect(app.store.run(dispatched.questions[0]!.run_id!).permissions).toEqual(['read']);
  });

  it('requires host authorization for reuse and narrows knowledge authorization to the investigation scope', () => {
    const { app, mailbox, run } = setup();
    const refs = [{ id: 'contract', revision: 1 }];
    const args = plan({ ...question(), execution: 'reuse', knowledge_refs: refs });
    expect(() => submit(mailbox, run, args)).toThrow(/host project authorization/);
    const resolveKnowledge = vi.fn((reader: Run) => {
      expect(reader.scope).toEqual({ read: ['src'], write: [] });
      return { summary: 'Authorized current knowledge' };
    });
    const enabled = new Mailbox(app.store, () => undefined, { exploration: true, resolveKnowledge });
    submit(enabled, run, args);
    expect(resolveKnowledge).toHaveBeenCalledWith(expect.anything(), refs);
    expect(app.store.listRuns(run.sessionId)).toHaveLength(1);
  });

  it('rejects oversized knowledge context through the existing spawn packet bounds', () => {
    const { app, run } = setup();
    const mailbox = new Mailbox(app.store, () => undefined, { exploration: true, resolveKnowledge: () => ({ text: 'x'.repeat(16_000) }) });
    expect(() => submit(mailbox, run, plan({ ...question(), knowledge_refs: [{ id: 'contract', revision: 1 }] }))).toThrow(/existing spawn_agent input bounds/);
    expect(app.store.listRuns(run.sessionId)).toHaveLength(1);
  });

  it('delivers structured partial findings and immutable decision provenance once', () => {
    const { app, mailbox, run } = setup();
    const response = submit(mailbox, run, plan());
    const child = app.store.run(response.questions[0]!.run_id!);
    const resultRef = app.store.blob({ text: JSON.stringify({ question_id: 'storage', summary: 'Contract found; migration remains unresolved.', claims: [], hypotheses: [], open_questions: ['Must version 1 migrate?'] }), knowledge: { id: 'contract', revision: 1 } });
    app.store.updateRun(child.id, { status: 'completed', resultRef, decisionVersion: 1 });
    const session = app.store.session(run.sessionId);
    app.store.putSession({ ...session, decisionVersion: 1 });
    mailbox.onTerminal(child.id);
    mailbox.onTerminal(child.id);
    const messages = app.store.messages(run.sessionId).filter(item => item.id === `terminal:${child.id}`);
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0]!.content)).toMatchObject({ summary: 'Contract found; migration remains unresolved.', questionId: 'storage', sourceDecisionVersion: 0, staleDecision: true, partial: true, openQuestions: ['Must version 1 migrate?'], knowledge: { id: 'contract', revision: 1 } });
  });

  it('delivers a real completion notification after knowledge persistence interrupts and the same run resumes', async () => {
    const root = temp();
    const provider = scripted(answer(JSON.stringify({ question_id: 'storage', summary: 'Source investigation remains incomplete.', claims: [], hypotheses: [], open_questions: ['Which storage version is required?'] })));
    const app = new Application(path.join(root, '.state'), provider, undefined, { exploration: true, structuredExploration: true, agentFactors: { D: false, E: false, B: false } });
    try {
      const main = app.createRun({ objective: 'Review storage', workspace: root, binding });
      const result = submit(app.coordinator.mailbox, main, plan());
      const childId = result.questions[0]!.run_id!;
      const fault = vi.spyOn(app.coordinator.knowledge!, 'persist').mockImplementationOnce(() => { throw new Error('simulated storage commit failure'); });
      expect((await app.coordinator.wake(childId)).status).toBe('interrupted');
      expect(app.store.message(`terminal:${childId}`)).toBeUndefined();
      expect(app.store.messages(main.sessionId).some(message => message.id.startsWith(`interrupted:${childId}:`))).toBe(true);
      expect(storageTestConnection(app.store).prepare('SELECT COUNT(*) AS n FROM knowledge_versions').get()).toEqual({ n: 0 });
      // A run-level fault interrupts only the faulting child; its parent keeps running.
      expect(app.store.run(main.id).status).not.toBe('interrupted');
      app.coordinator.prepareResume(childId);
      expect((await app.coordinator.wake(childId)).status).toBe('completed');
      expect(fault).toHaveBeenCalledTimes(2);
      expect(JSON.parse(app.store.message(`terminal:${childId}`)!.content)).toMatchObject({ status: 'completed', knowledge: { id: 'storage', revision: 1 }, partial: true });
      expect(storageTestConnection(app.store).prepare('SELECT COUNT(*) AS n FROM knowledge_versions').get()).toEqual({ n: 1 });
      expect(app.store.calls(childId).filter(call => call.kind === 'model')).toHaveLength(1);
    } finally { await app.shutdown(); }
  });

  it('saves reread evidence after a running investigation receives a decision, while refusing adoption of the old assignment', async () => {
    const root = temp();
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src/storage.ts'), 'export const version = 1;\n');
    let entered!: () => void;
    let release!: () => void;
    const inFlight = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const provider: Provider = { async complete() {
      const child = app.store.listRuns().find(run => run.parentId)!;
      if (child.step === 0 || child.step === 2) return calls(call('file.read', { path: 'src/storage.ts' }, child.step === 0 ? 'initial-read' : 'latest-read'));
      if (child.step === 1) { entered(); await released; }
      const evidence = app.store.calls(child.id).findLast(call => call.name === 'file.read' && call.status === 'succeeded')!;
      return answer(JSON.stringify({ question_id: 'storage', summary: 'Storage exports version 1.', claims: [{ text: 'Storage exports version 1.', basis: 'source_observation', evidence_ids: [evidence.id] }], hypotheses: [], open_questions: [] }));
    } };
    const app = new Application(path.join(root, '.state'), provider, undefined, { exploration: true, structuredExploration: true, agentFactors: { D: false, E: false, B: false } });
    try {
      const main = app.createRun({ objective: 'Review storage', workspace: root, binding });
      const result = submit(app.coordinator.mailbox, main, plan());
      const childId = result.questions[0]!.run_id!;
      const pending = app.coordinator.wake(childId);
      await inFlight;
      app.submitInput(main.id, 'Prioritize a different storage decision', { decision: true });
      release();
      const completed = await pending;
      expect(completed.status).toBe('completed');
      expect(completed.exploration?.decisionVersion).toBe(0);
      expect(completed.decisionVersion).toBe(1);
      const reads = app.store.calls(childId).filter(call => call.name === 'file.read');
      expect(reads.map(call => call.decisionVersion)).toEqual([0, 1]);
      expect(app.store.readBlob<{ knowledge: { id: string; revision: number } }>(completed.resultRef!).knowledge).toEqual({ id: 'storage', revision: 1 });
      const body = JSON.parse(app.coordinator.knowledge!.read(main.id, { id: 'storage', revision: 1 }).text) as { source_decision_version: number; evidence: { sourceCallId: string }[] };
      expect(body.source_decision_version).toBe(0);
      expect(body.evidence[0]!.sourceCallId).toBe(reads[1]!.id);
      expect(JSON.parse(app.store.message(`terminal:${childId}`)!.content)).toMatchObject({ status: 'completed', sourceDecisionVersion: 0, staleDecision: true });
      expect(() => app.updateProgress(main.id, { knowledge_uses: [{ id: 'storage', revision: 1, purpose: 'Do not adopt superseded assignments automatically' }] })).toThrow(/superseded decision/);
      expect(app.store.events(main.id).some(event => event.type === 'task.progress.updated')).toBe(false);
    } finally { release(); await app.shutdown(); }
  });
});
