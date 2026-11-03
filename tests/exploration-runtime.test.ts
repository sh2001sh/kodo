import { storageTestConnection } from '../src/storage/test-access.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Application } from '../src/application/index.js';
import { defaultCard } from '../src/agents/card.js';
import type { Message, Provider, Run } from '../src/runtime/types.js';
import { answer, binding, call, calls, temp } from './helpers.js';

type Request = Parameters<Provider['complete']>[0];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function owner(app: Application, request: Request): Run {
  const id = /Run ID: ([^. ]+)\./u.exec(request.messages[0]!.content ?? '')?.[1];
  if (!id) throw new Error('Missing run ID');
  return app.store.run(id);
}
function result<T>(request: Request, id: string): T {
  const message = request.messages.findLast(message => message.role === 'tool' && message.tool_call_id === id);
  if (!message || message.role !== 'tool') throw new Error(`Missing ${id}`);
  return JSON.parse(message.content) as T;
}
const question = (id = 'edge-contract') => ({ id, question: 'What does edge return for zero?', inputs: ['src/edge.ts'], consumer: 'Boundary implementation and validation', deliverable: 'Source contract and unresolved items', execution: 'child', reason: 'Independent contract investigation while the main reads the view', read_scope: ['src/edge.ts'] });
function dispatch(app: Application, main: Run, id = 'edge-contract'): Run {
  const mailbox = app.coordinator.mailbox;
  const args = { batch_id: id, decision_version: main.decisionVersion ?? 0, questions: [question(id)] };
  const output = mailbox.execute(main, id, 'exploration.plan', mailbox.validate(main, 'exploration.plan', JSON.stringify(args))) as { questions: { run_id: string }[] };
  return app.store.run(output.questions[0]!.run_id);
}
function finding(app: Application, run: Run, text = 'edge(0) returns true') {
  const evidence = app.store.calls(run.id).find(call => call.name === 'file.read' && call.status === 'succeeded');
  return { question_id: run.exploration!.questionId, summary: text, claims: [{ text, basis: 'source_observation', evidence_ids: [evidence!.id] }], hypotheses: [], open_questions: [] };
}
function setup(provider: Provider, exploration?: boolean) {
  const root = temp();
  mkdirSync(path.join(root, 'src'));
  writeFileSync(path.join(root, 'src/edge.ts'), 'export const edge = (value: number) => value === 0;\n');
  writeFileSync(path.join(root, 'src/view.ts'), 'export const title = "Boundary";\n');
  const app = new Application(path.join(root, '.state'), provider, undefined, { exploration, structuredExploration: true, agentFactors: { D: false, E: false, B: false } });
  const main = app.createRun({ objective: 'Inspect the boundary contract and view', workspace: root, binding, permissions: ['read', 'write', 'exec'] });
  return { app, root, main };
}

describe('project exploration runtime integration', () => {
  it('overlaps actual model requests, saves once, inspects evidence, adopts and reuses only unchanged knowledge', async () => {
    const childStarted = deferred();
    const mainStarted = deferred();
    let active = 0;
    let peak = 0;
    let childId = '';
    const provider: Provider = { async complete(request) {
      active++; peak = Math.max(peak, active);
      try {
        const run = owner(app, request);
        if (run.parentId) {
          if (run.step === 0) {
            childStarted.resolve(); await mainStarted.promise;
            expect(request.tools.some(tool => /patch|exec|web|knowledge|skill|spawn|exploration/.test(tool.name))).toBe(false);
            return calls(call('file.read', { path: 'src/edge.ts' }));
          }
          if (run.step === 1) return calls(call('inspect_run', { run_id: run.id }));
          return answer(JSON.stringify(finding(app, run)));
        }
        if (run.step === 0) return calls(call('exploration.plan', { batch_id: 'initial', decision_version: 0, questions: [question()] }, 'plan'));
        if (run.step === 1) {
          childId = result<{ questions: { run_id: string }[] }>(request, 'plan').questions[0]!.run_id;
          mainStarted.resolve(); await childStarted.promise;
          return calls(call('file.read', { path: 'src/view.ts' }));
        }
        if (run.step === 2) return calls(call('wait_for_events', { run_ids: [childId], mode: 'all' }));
        if (run.step === 3) {
          const terminal = app.store.messages(run.sessionId).find(message => message.id === `terminal:${childId}`)!;
          expect(JSON.parse(terminal.content)).toMatchObject({ questionId: 'edge-contract', knowledge: { id: 'edge-contract', revision: 1 } });
          return calls(call('inspect_run', { run_id: childId }, 'inspect'));
        }
        if (run.step === 4) {
          expect(result<{ result: { text: string } }>(request, 'inspect').result.text).toContain('edge(0) returns true');
          return calls(call('knowledge.read', { id: 'edge-contract', revision: 1 }, 'knowledge'));
        }
        if (run.step === 5) {
          expect(result<{ freshness: string; confirmation: string }>(request, 'knowledge')).toMatchObject({ freshness: 'current', confirmation: 'candidate' });
          return calls(call('update_progress', { knowledge_uses: [{ id: 'edge-contract', revision: 1, purpose: 'Keep the zero boundary intact' }] }));
        }
        return answer('Source evidence inspected; preserve edge(0) === true.');
      } finally { active--; }
    } };
    const { app, root, main } = setup(provider);
    try {
      expect((await app.run(main.id)).status).toBe('completed');
      expect(peak).toBe(2);
      expect(storageTestConnection(app.store).prepare('SELECT COUNT(*) AS n FROM knowledge_versions').get()).toEqual({ n: 1 });
      expect(storageTestConnection(app.store).prepare('SELECT COUNT(*) AS n FROM knowledge_uses').get()).toEqual({ n: 1 });
      expect(app.store.calls(main.id).filter(call => call.name === 'file.read')).toHaveLength(1);
      const next = app.createRun({ objective: 'Reuse the contract in a separate session', workspace: root, binding });
      expect(app.coordinator.knowledge!.validateUse(next.id, { id: 'edge-contract', revision: 1 }).freshness).toBe('current');
      writeFileSync(path.join(root, 'src/view.ts'), 'unrelated modification');
      expect(app.coordinator.knowledge!.validateUse(next.id, { id: 'edge-contract', revision: 1 }).freshness).toBe('current');
      writeFileSync(path.join(root, 'src/edge.ts'), 'export const edge = () => false;\n');
      expect(app.coordinator.knowledge!.read(next.id, { id: 'edge-contract', revision: 1 }).freshness).toBe('stale');
      expect(() => app.updateProgress(next.id, { knowledge_uses: [{ id: 'edge-contract', revision: 1, purpose: 'Do not accept obsolete code' }] })).toThrow('stale, unknown');
      expect(app.store.events(next.id).some(event => event.type === 'task.progress.updated')).toBe(false);
    } finally { await app.shutdown(); }
  });

  it('corrects invalid JSON and forged evidence before saving a real source observation', async () => {
    const provider: Provider = { async complete(request) {
      const run = owner(app, request);
      if (run.step === 0) return answer('A prose report is not the required result.');
      if (run.step === 1) return answer(JSON.stringify({ question_id: 'edge-contract', summary: 'Invented', claims: [{ text: 'Unsupported', basis: 'source_observation', evidence_ids: ['forged'] }], hypotheses: [], open_questions: [] }));
      if (run.step === 2) return calls(call('file.read', { path: 'src/edge.ts' }));
      return answer(JSON.stringify(finding(app, run)));
    } };
    const { app, main } = setup(provider);
    try {
      const child = dispatch(app, main);
      expect((await app.coordinator.wake(child.id)).status).toBe('completed');
      expect(app.store.events(child.id).filter(event => event.type === 'completion.correction_requested')).toHaveLength(2);
      expect(app.coordinator.knowledge!.search(main.id).items).toMatchObject([{ id: 'edge-contract', revision: 1, confirmation: 'candidate' }]);
      expect(app.store.calls(child.id).some(call => call.name === 'artifact.write')).toBe(false);
    } finally { await app.shutdown(); }
  });

  it('fails after two corrections and does not persist unresolved malformed results', async () => {
    let requests = 0;
    const { app, main } = setup({ async complete() { requests++; return answer('{broken'); } });
    try {
      const child = dispatch(app, main);
      const ended = await app.coordinator.wake(child.id);
      expect(ended).toMatchObject({ status: 'failed', error: expect.stringContaining('QUALITY_FAILED') });
      expect(requests).toBe(3);
      expect(app.coordinator.knowledge!.search(main.id).items).toEqual([]);
    } finally { await app.shutdown(); }
  });

  it('lets independent semantic acceptance reject a well formed but false claim', async () => {
    const provider: Provider = { async complete(request) {
      const run = owner(app, request);
      return run.step === 0 ? calls(call('file.read', { path: 'src/edge.ts' })) : answer(JSON.stringify(finding(app, run, 'edge(0) returns false')));
    } };
    const { app, main } = setup(provider);
    try {
      const child = dispatch(app, main);
      app.setCompletionValidator(child.id, ({ response }) => ({ passed: JSON.parse(response.message.content!).summary === 'edge(0) returns true', feedback: 'Independent source oracle: zero must return true.' }));
      expect((await app.coordinator.wake(child.id)).status).toBe('failed');
      expect(app.coordinator.knowledge!.search(main.id).items).toEqual([]);
    } finally { await app.shutdown(); }
  });

  it('cancels unstarted old exploration, ignores late completion after cancellation and preserves source decision versions', async () => {
    const started = deferred();
    const release = deferred();
    const provider: Provider = { async complete() { started.resolve(); await release.promise; return answer('late untrusted response'); } };
    const { app, main } = setup(provider);
    try {
      const queued = dispatch(app, main, 'queued');
      app.submitInput(main.id, 'Investigate a different target', { decision: true });
      expect(app.store.run(queued.id).status).toBe('cancelled');
      const current = app.store.updateRun(main.id, { decisionVersion: 1 });
      const running = dispatch(app, current, 'running');
      const pending = app.coordinator.wake(running.id);
      await started.promise;
      app.coordinator.cancel(running.id);
      release.resolve();
      expect((await pending).status).toBe('cancelled');
      expect(app.coordinator.knowledge!.search(main.id).items).toEqual([]);
    } finally { release.resolve(); await app.shutdown(); }
  });

  it.each([undefined, false, true])('adds no mandatory planning, child or knowledge calls to small tasks (exploration option %s)', async enabled => {
    const seen: Request[] = [];
    const { app, main } = setup({ async complete(request) { seen.push(request); return answer('Direct small task.'); } }, enabled);
    try {
      expect((await app.run(main.id)).status).toBe('completed');
      expect(seen).toHaveLength(1);
      for (const name of ['exploration.plan', 'knowledge.search', 'knowledge.read']) {
        expect(seen[0]!.tools.some(tool => tool.name === name)).toBe(enabled !== false);
      }
      expect(Boolean(app.coordinator.knowledge)).toBe(enabled !== false);
      expect(app.store.listRuns(main.sessionId)).toHaveLength(1);
      expect(app.store.events(main.id).some(event => /^(exploration|knowledge)\./.test(event.type))).toBe(false);
      expect(app.store.readBlob<Message[]>(app.store.run(main.id).contextRef).some(message => message.content?.includes('builtin/exploration'))).toBe(false);
    } finally { await app.shutdown(); }
  });

  it.each([false, true])('preserves recovery while a host explicitly disables exploration (custom card %s)', async customCard => {
    const root = temp();
    const directory = path.join(root, '.state');
    let requests = 0;
    const provider: Provider = { async complete(request) {
      requests++;
      const run = owner(app, request);
      if (run.parentId) return answer(JSON.stringify({ question_id: run.exploration!.questionId, summary: 'Source investigation remains unresolved after host recovery.', claims: [], hypotheses: [], open_questions: ['The source contract still needs investigation.'] }));
      return answer('Resumed by the enabled host; the child reported its unresolved source investigation.');
    } };
    let app = new Application(directory, provider, undefined, { exploration: true, structuredExploration: true, agentFactors: { D: false, E: false, B: false } });
    const main = app.createRun({ objective: 'Resume exploration safely', workspace: root, binding, ...(customCard ? { card: defaultCard } : {}) });
    const child = dispatch(app, main);
    await app.shutdown();
    app = new Application(directory, provider, undefined, { exploration: false, structuredExploration: true, agentFactors: { D: false, E: false, B: false } });
    try {
      expect((await app.coordinator.wake(main.id)).status).toBe('interrupted');
      expect(app.store.run(child.id).status).not.toBe('cancelled');
      expect(requests).toBe(0);
    } finally { await app.shutdown(); }
    app = new Application(directory, provider, undefined, { structuredExploration: true, agentFactors: { D: false, E: false, B: false } });
    try {
      app.coordinator.prepareResume(main.id);
      // Recovery must not silently cancel an outstanding child just to finish the main run.
      expect((await app.coordinator.wake(main.id)).status).toBe('waiting');
      expect(app.store.run(child.id).status).not.toBe('cancelled');
      expect(requests).toBe(1);
      expect((await app.coordinator.wake(child.id)).status).toBe('completed');
      expect((await app.coordinator.wake(main.id)).status).toBe('completed');
      expect(requests).toBe(3);
      expect(app.store.events(main.id, { types: ['completion.correction_requested'] })).toHaveLength(0);
    } finally { await app.shutdown(); }
  });
});
