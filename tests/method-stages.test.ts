import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { parseCard, serializeCard } from '../src/agents/card.js';
import { activeMethod, methodCatalogDigest, methodSkillId } from '../src/extensions/methods.js';
import { readTaskGraph } from '../src/runtime/task-graph.js';
import { unloadMethods } from '../src/runtime/method-context.js';
import { agentCommand } from '../src/tui/agents.js';
import { PackageRegistry } from '../src/packages/registry.js';
import { createLocalServer } from '../src/web/index.js';
import type { Card, Message, Provider } from '../src/runtime/types.js';
import { answer, binding, call, calls, scripted, temp } from './helpers.js';

const apps = new Set<Application>();
afterEach(async () => { for (const app of apps) await app.shutdown(); apps.clear(); });
const options = { inlineMethods: true, toolProfile: 'compact-v2' as const, compaction: false as const, projectMemory: false, globalInstructions: false as const, agentFactors: { A: false, B: false, C: false, D: false, E: false } };
const card = (extra: Partial<Card> = {}): Card => parseCard(serializeCard({ id: 'test/stage', name: 'Stage', version: '1.0.0', digest: '', schemaVersion: 2,
  description: 'Inspect a local report and check its contents.', catalog: { path: 'reports/local' }, routing: { use_when: ['Check a report'], mode: 'write' },
  tools: ['file.read', 'process.exec', 'artifact.write'], execution: { modes: ['inline', 'child'] }, prompt: 'METHOD_BODY: inspect original evidence and check the report.', ...extra }));
const task = (action: string, rest: Record<string, unknown> = {}) => calls(call('task', { action, node_id: 'report', expectedGeneration: 1, ...rest }));
function create(provider: Provider, view: 'stable' | 'active' = 'stable') {
  const root = temp(); writeFileSync(path.join(root, 'input.txt'), 'budget=2100');
  const app = new Application(path.join(root, 'state'), provider, undefined, { ...options, methodToolView: view }); apps.add(app);
  const method = card(); app.registerCard(method);
  const run = app.createRun({ workspace: root, objective: 'Check the report.', binding, permissions: ['read', 'write', 'exec'] });
  app.updateSessionMethods(run.id, { expectedDigest: methodCatalogDigest(app.store.session(run.sessionId).methodCards), install: [method] });
  return { app, root, run, method };
}
const declare = task('declare', { tasks: [{ id: 'report', goal: 'Check the report.', needs: {} }] });
const verify = calls(call('process.exec', { program: process.execPath, args: ['-e', "if(require('node:fs').readFileSync('input.txt','utf8')!=='budget=2100')process.exit(1)"] }));

describe('method stages', () => {
  it('publishes a method through the TUI and the authenticated Web session API', async () => {
    const { app, root, run } = create(scripted());
    const installed = card({ id: 'test/installed' });
    const file = path.join(root, 'AGENT.md'); writeFileSync(file, serializeCard(installed));
    const context = { app, workspace: root, runId: run.id, registry: new PackageRegistry(path.join(root, 'packages')), startTask: async () => {}, wake: () => {} };
    const initial = methodCatalogDigest(app.store.session(run.sessionId).methodCards);
    await agentCommand(context, ['install-method', file, '--digest', initial]);
    expect((await agentCommand(context, ['methods'])).lines.join('\n')).toContain('test/installed@1.0.0');
    const server = await createLocalServer(app, { workspace: root, binding, permissions: ['read', 'write', 'exec'] });
    try {
      const auth = await fetch(server.origin + '/api/auth', { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: server.startupSecret }) });
      const cookie = auth.headers.get('set-cookie')!.split(';')[0]!;
      const { csrf } = await auth.json() as { csrf: string };
      const headers = { Cookie: cookie, Origin: server.origin, 'Content-Type': 'application/json', 'X-Kodo-CSRF': csrf, 'Idempotency-Key': 'methods-disable-fixture' };
      const listed = await fetch(`${server.origin}/api/runs/${run.id}/methods`, { headers });
      expect(listed.status).toBe(200);
      const { digest } = await listed.json() as { digest: string };
      const body = JSON.stringify({ expectedDigest: digest, disable: [installed.id] });
      const revised = await fetch(`${server.origin}/api/runs/${run.id}/methods`, { method: 'POST', headers, body });
      expect(revised.status, await revised.clone().text()).toBe(202);
      const replayed = await fetch(`${server.origin}/api/runs/${run.id}/methods`, { method: 'POST', headers, body });
      expect(replayed.status).toBe(200);
      expect(app.store.session(run.sessionId).methodCards?.some(ref => ref.id === installed.id)).toBe(false);
    } finally { await server.close(); }
  });

  it('leaves a stage running when completion lacks check evidence, then accepts a real read', async () => {
    const { app, run } = create(scripted(declare, task('activate', { card: 'test/stage' }), task('done', { result: { name: 'report', content: 'Unchecked report.' } }), async () => {
      expect(readTaskGraph(app.store, run.id).nodes[0]!.state).toBe('running');
      expect(activeMethod(app.store, run.id)?.nodeId).toBe('report');
      return calls(call('file.read', { path: 'input.txt' }));
    }, async () => {
      const checked = app.store.calls(run.id).find(item => item.name === 'file.read')!;
      return task('done', { result: { name: 'report', content: 'The source contains budget=2100.' }, checkCallIds: [checked.id] });
    }, answer()));
    expect((await app.run(run.id)).status).toBe('completed');
    expect(app.store.events(run.id, { types: ['method.ended'] })).toHaveLength(1);
  });

  it('accepts a read-only report, replays done idempotently, and recovers an activated stage', async () => {
    const { app, run } = create(scripted(declare, task('activate', { card: 'test/reader' }), calls(call('file.read', { path: 'input.txt' })), async () => {
      const checked = app.store.calls(run.id).find(item => item.name === 'file.read')!;
      return task('done', { result: { name: 'report', content: 'The source states budget=2100.' }, checkCallIds: [checked.id] });
    }, async () => {
      const done = app.store.calls(run.id).filter(item => item.name === 'task').at(-1)!;
      return calls(app.store.readBlob(done.requestRef));
    }, answer()));
    app.updateSessionMethods(run.id, { expectedDigest: methodCatalogDigest(app.store.session(run.sessionId).methodCards), install: [card({ id: 'test/reader', routing: { use_when: ['Read reports'], mode: 'read' }, tools: ['file.read'] })] });
    const unsubscribe = app.store.subscribe(event => { if (event.type === 'method.loaded' && event.runId === run.id) app.coordinator.interrupt(run.id); });
    expect((await app.run(run.id)).status).toBe('interrupted'); unsubscribe();
    const resumed = await app.recover(run.id);
    expect(resumed.status, resumed.error).toBe('completed');
    const nodes = app.store.events(run.id, { types: ['task.node.updated'] }).filter(event => event.data.state === 'done');
    expect(nodes).toHaveLength(1);
    expect(app.store.events(run.id, { types: ['method.loaded'] })).toHaveLength(1);
    expect(app.store.readBlob<{ checks: { kind: string }[] }>(readTaskGraph(app.store, run.id).nodes[0]!.resultRef!).checks[0]!.kind).toBe('source-inspection');
  });

  it('uses an independent child for a child stage and accepts its original evidence', async () => {
    let parentStep = 0, childStep = 0;
    const { app, run } = create({ async complete(request) {
      const child = request.messages.some(message => message.role === 'user' && message.content?.includes('CHILD_ONLY_REPORT'));
      if (child) return childStep++ === 0 ? calls(call('file.read', { path: 'input.txt' })) : answer('The source states budget=2100.');
      switch (parentStep++) {
        case 0: return task('declare', { tasks: [{ id: 'report', goal: 'CHILD_ONLY_REPORT', needs: { execution: 'child' } }] });
        case 1: return task('activate', { card: 'test/reader' });
        case 2: return task('wait');
        case 3: {
          const childRun = app.store.listRuns(run.sessionId).find(owner => owner.parentId === run.id)!;
          const checked = app.store.calls(childRun.id).find(item => item.name === 'file.read')!;
          return task('done', { result: { name: 'report', content: 'Inspected child source evidence: budget=2100.' }, checkCallIds: [checked.id] });
        }
        default: return answer('The child report was checked.');
      }
    } });
    app.updateSessionMethods(run.id, { expectedDigest: methodCatalogDigest(app.store.session(run.sessionId).methodCards), install: [card({ id: 'test/reader', routing: { use_when: ['Read reports'], mode: 'read' }, tools: ['file.read'] })] });
    const result = await app.run(run.id);
    expect(result.status, result.error).toBe('completed');
    expect(app.store.listRuns(run.sessionId).filter(owner => owner.parentId === run.id)).toHaveLength(1);
    expect(readTaskGraph(app.store, run.id).nodes[0]).toMatchObject({ state: 'done', runId: expect.any(String) });
  });

  it.each(['stable', 'active'] as const)('completes with real artifact and check evidence using the %s tool view', async view => {
    const requests: Parameters<Provider['complete']>[0][] = [];
    const { app, run, method } = create(scripted(declare, task('activate', { card: 'test/stage' }), async request => {
      requests.push(request); expect(request.tools.some(tool => tool.name === 'artifact.write')).toBe(true);
      return verify;
    }, calls(call('artifact.write', { name: 'report', content: 'The report contains budget=2100.', kind: 'report' })), async () => {
      const saved = app.store.calls(run.id).find(item => item.name === 'artifact.write')!;
      const artifact = app.store.readBlob<{ id: string }>(saved.resultRef!);
      const checked = app.store.calls(run.id).find(item => item.name === 'process.exec')!;
      return task('done', { resultRef: artifact.id, checkCallIds: [checked.id] });
    }, async request => {
      requests.push(request); expect(activeMethod(app.store, run.id)).toBeUndefined();
      expect(readTaskGraph(app.store, run.id).nodes[0]!.state).toBe('done');
      return answer('The report was checked.');
    }), view);
    const completed = await app.run(run.id);
    expect(completed.status, JSON.stringify(app.store.calls(run.id).filter(c => c.status !== 'succeeded').map(c => c.resultRef && app.store.readBlob(c.resultRef)))).toBe('completed');
    expect(app.store.events(run.id, { types: ['method.loaded'] })[0]!.data.card).toMatchObject({ digest: method.digest });
    expect(requests[0]!.tools.some(tool => tool.name === 'file.patch')).toBe(view === 'stable');
    const node = readTaskGraph(app.store, run.id).nodes[0]!;
    expect(app.store.readBlob(node.resultRef!)).toMatchObject({ checks: [{ callId: expect.any(String) }], acceptance: { kind: 'model-review' } });
  });

  it('rejects named method stage inputs instead of silently dropping requirements', async () => {
    // 1c: methods carry no named inputs; the failure keeps the stage pending so it can be dropped.
    const { app, run } = create(scripted(declare,
      task('activate', { card: 'test/stage', inputs: { budget: '2100' } }),
      task('drop', { reason: 'Required business input is unsupported by this method.' }),
      answer(), answer('The report stage was dropped because named inputs are unavailable.')));
    const result = await app.run(run.id);
    expect(result.status, JSON.stringify(app.store.calls(run.id).filter(c => c.status !== 'succeeded').map(c => c.resultRef && app.store.readBlob(c.resultRef)))).toBe('completed');
    const failed = app.store.calls(run.id).find(item => item.name === 'task' && item.status === 'failed')!;
    expect(JSON.stringify(app.store.readBlob(failed.resultRef!))).toContain('METHOD_INPUTS');
    expect(app.store.events(run.id, { types: ['task.node.updated'] }).filter(event => event.data.state === 'running')).toHaveLength(0);
    expect(activeMethod(app.store, run.id)).toBeUndefined();
  });

  it('retains stage inputs and observations when unloading its method', async () => {
    const { app, run } = create(scripted(declare, task('activate', { card: 'test/stage' }), task('drop', { reason: 'No further work.' }), answer(), answer('The report stage was dropped.')));
    await app.run(run.id);
    const activation = app.store.calls(run.id).find(item => item.name === 'task' && (app.store.readBlob<{ methodInstance?: string }>(item.resultRef!).methodInstance))!;
    const original = { ...app.store.readBlob<Record<string, unknown>>(activation.resultRef!), inputs: { budget: '2100' }, knowledge: { source: 'invoice' } };
    const messages: Message[] = [{ role: 'assistant', content: null, tool_calls: [call('task', { action: 'activate' }, 'activation')] }, { role: 'tool', tool_call_id: 'activation', content: JSON.stringify(original) }];
    const projected = unloadMethods(app.store, run, messages)!;
    expect(JSON.stringify(projected.messages)).not.toContain('METHOD_BODY');
    expect(JSON.parse(projected.messages[1]!.content!)).toMatchObject({ inputs: { budget: '2100' }, knowledge: { source: 'invoice' }, methodUnloaded: true });
  });

  it('keeps active versions pinned while publishing and disabling the next version, including restart', async () => {
    const first = card(), next = card({ version: '2.0.0', prompt: 'NEW_METHOD' });
    const { app, root, run } = create(scripted(calls(call('skill.load', { id: methodSkillId(first) })), async (_request, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }); app.coordinator.interrupt(run.id);
    })));
    expect((await app.run(run.id)).status).toBe('interrupted');
    const before = methodCatalogDigest(app.store.session(run.sessionId).methodCards);
    const revised = app.updateSessionMethods(run.id, { expectedDigest: before, install: [next] });
    expect(activeMethod(app.store, run.id)?.card.digest).toBe(first.digest);
    expect(() => app.updateSessionMethods(run.id, { expectedDigest: before, disable: [first.id] })).toThrow(/method catalog/);
    app.updateSessionMethods(run.id, { expectedDigest: revised.digest, disable: [first.id] });
    await app.shutdown(); apps.delete(app);
    const reopened = new Application(path.join(root, 'state'), scripted(calls(call('skill.list', {})), answer()), undefined, options); apps.add(reopened);
    expect(activeMethod(reopened.store, run.id)?.card.digest).toBe(first.digest);
    const recovered = await reopened.recover(run.id);
    expect(recovered.status).toBe('completed');
    const listed = reopened.store.calls(recovered.id).find(item => item.name === 'skill.list')!;
    const skills = reopened.store.readBlob<{ skills: { id: string }[]; unavailableMethods: unknown[] }>(listed.resultRef!);
    expect(skills.skills.map(skill => skill.id)).toEqual([methodSkillId(first)]);
    expect(skills.unavailableMethods).toEqual([]);
  });

  it('publishes reusable main-run observations even when exploration scheduling is disabled', async () => {
    const root = temp(); writeFileSync(path.join(root, 'input.txt'), 'budget=2100');
    const app: Application = new Application(path.join(root, 'state'), scripted(calls(call('file.read', { path: 'input.txt' })), async () => {
      const read = app.store.calls(run.id).find(item => item.name === 'file.read')!;
      return calls(call('knowledge.publish', { question_id: 'budget', summary: 'Budget source', claims: [{ text: 'budget=2100', basis: 'source_observation', evidence_ids: [read.id] }], hypotheses: [], open_questions: [] }));
    }, calls(call('knowledge.search', { query: 'Budget' })), answer()), undefined, { ...options, exploration: false }); apps.add(app);
    const run = app.createRun({ workspace: root, objective: 'Read the budget.', binding });
    const result = await app.run(run.id);
    expect(result.status, JSON.stringify(app.store.calls(run.id).filter(c => c.status !== 'succeeded').map(c => c.resultRef && app.store.readBlob(c.resultRef)))).toBe('completed');
    const published = app.store.calls(run.id).find(item => item.name === 'knowledge.publish')!;
    expect(published.status, JSON.stringify(app.store.readBlob(published.resultRef!))).toBe('succeeded');
    const found = app.store.calls(run.id).find(item => item.name === 'knowledge.search')!;
    expect(app.store.readBlob(found.resultRef!)).toMatchObject({ items: [expect.objectContaining({ confirmation: 'candidate', freshness: 'current' })] });
  });
});
