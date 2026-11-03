import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { parseCard, serializeCard } from '../src/agents/card.js';
import { activeMethod, methodSkillId } from '../src/extensions/methods.js';
import { digest } from '../src/storage/index.js';
import type { Card, Provider } from '../src/runtime/types.js';
import { readHistory } from '../src/runtime/history.js';
import { answer, binding, call, calls, scripted, temp } from './helpers.js';

const applications = new Set<Application>();
afterEach(async () => { for (const app of applications) await app.shutdown(); applications.clear(); });
const options = { inlineMethods: true, compaction: false as const, projectMemory: false, globalInstructions: false as const, agentFactors: { A: false, B: false, C: false, D: false, E: false } };
const method = (id: string, prompt = `Method ${id}: inspect the supplied figures.`, extra: Partial<Card> = {}): Card => parseCard(serializeCard({
  id: `test/${id}`, version: '1.0.0', name: id, description: `Method for ${id}`, digest: '', schemaVersion: 2,
  catalog: { path: 'business/reporting' }, routing: { use_when: [`Perform ${id}`], mode: 'read' },
  tools: ['file.read'], execution: { modes: ['inline'] }, prompt, ...extra,
}));
function appAt(root: string, provider: Provider, inlineMethods = true): Application {
  const app = new Application(path.join(root, 'data'), provider, undefined, { ...options, inlineMethods });
  applications.add(app); return app;
}

describe('inline card methods', () => {
  it.each([true, false])('shows method discovery in the first real request (enabled=%s), without preloading bodies', async enabled => {
    const root = temp(), inline = method('release', 'PRIVATE_RELEASE_RULE'), child = method('child', 'PRIVATE_CHILD_RULE', { execution: { modes: ['child'] } });
    const incompatible = method('inputs', 'PRIVATE_INPUT_RULE', { inputs: [{ name: 'source', kind: 'text', required: true }] });
    const seen: Parameters<Provider['complete']>[0][] = [];
    const responses = [calls(call('skill.list', {})), answer()];
    const app = appAt(root, { async complete(request) { seen.push(structuredClone(request)); return responses.shift()!; } }, enabled);
    [inline, child, incompatible].forEach(card => app.registerCard(card));
    const run = app.createRun({ workspace: root, objective: 'Prepare a release.', binding });
    expect((await app.run(run.id)).status).toBe('completed');
    const first = JSON.stringify(seen[0]!.messages);
    expect(first.includes(methodSkillId(inline))).toBe(enabled);
    expect(first).not.toContain('PRIVATE_RELEASE_RULE');
    expect(first).not.toContain('PRIVATE_CHILD_RULE');
    expect(first).not.toContain(methodSkillId(child));
    if (enabled) {
      expect(first).toContain('execution_modes');
      expect(first).toContain('skill.load');
      expect(first).toContain('availability_check');
      const listed = app.store.calls(run.id).find(call => call.name === 'skill.list')!;
      const result = app.store.readBlob<{ skills: { id: string }[]; unavailableMethods: { id: string; reason: string }[] }>(listed.resultRef!);
      expect(result.skills.map(skill => skill.id)).toContain(methodSkillId(inline));
      expect(result.skills.map(skill => skill.id)).not.toContain(methodSkillId(incompatible));
      expect(result.unavailableMethods).toContainEqual(expect.objectContaining({ id: methodSkillId(incompatible), reason: expect.stringContaining('task activate') }));
    }
  });

  it('unloads only ended method bodies at pressure checkpoints and keeps them readable after restart', async () => {
    const root = temp(), first = method('old', 'OLD_METHOD '.repeat(2500)), second = method('current', 'CURRENT_METHOD '.repeat(1000));
    const seen: Parameters<Provider['complete']>[0][] = [];
    const responses = [calls(call('skill.load', { id: methodSkillId(first) })), calls(call('skill.load', { id: methodSkillId(second), maxChars: 32000 })), answer()];
    const app = new Application(path.join(root, 'data'), { async complete(request) { seen.push(structuredClone(request)); return responses.shift()!; } }, undefined,
      { ...options, compaction: { strategy: 'mask', workInputTokens: 4000 } });
    applications.add(app); app.registerCard(first); app.registerCard(second);
    const run = app.createRun({ workspace: root, objective: 'Keep the budget ceiling at 2100 and compare figures.', binding });
    expect((await app.run(run.id)).status).toBe('completed');
    const last = JSON.stringify(seen.at(-1)!.messages);
    expect(last).not.toContain('OLD_METHOD');
    expect(last).toContain(second.prompt);
    expect(last).toContain('2100');
    expect(last).toContain('methodUnloaded');
    expect(seen.every(request => JSON.stringify(request.tools) === JSON.stringify(seen[0]!.tools))).toBe(true);
    const event = app.store.events(run.id, { types: ['context.methods.unloaded'] })[0]!;
    expect(event).toBeDefined();
    await app.shutdown(); applications.delete(app);
    const reopened = appAt(root, scripted());
    const original = readHistory(reopened.store, run.id, { ref: event.data.archivedRef as string, offset: (event.data.offsets as number[])[0], limit: 1, maxChars: 32000 });
    expect(JSON.stringify(original)).toContain('OLD_METHOD');
  });

  it('preserves method bodies for the marking-only ablation under identical pressure', async () => {
    const root = temp(), first = method('old', 'OLD_METHOD '.repeat(600)), second = method('current', 'CURRENT_METHOD '.repeat(600));
    const seen: Parameters<Provider['complete']>[0][] = [];
    const responses = [calls(call('skill.load', { id: methodSkillId(first) })), calls(call('skill.load', { id: methodSkillId(second) })), answer()];
    const app = new Application(path.join(root, 'data'), { async complete(request) { seen.push(structuredClone(request)); return responses.shift()!; } }, undefined,
      { ...options, methodUnloading: false, compaction: { strategy: 'mask', workInputTokens: 4000 } });
    applications.add(app); app.registerCard(first); app.registerCard(second);
    const run = app.createRun({ workspace: root, objective: 'Inspect figures.', binding });
    expect((await app.run(run.id)).status).toBe('completed');
    expect(app.store.events(run.id, { types: ['context.methods.unloaded'] })).toHaveLength(0);
    expect(JSON.stringify(seen.at(-1)!.messages)).toContain('CURRENT_METHOD');
  });

  it('switches in real requests without removing previous evidence or changing tool schemas', async () => {
    const root = temp(), first = method('compare'), second = method('budget');
    const seen: Parameters<Provider['complete']>[0][] = [];
    const responses = [calls(call('skill.list', {})), calls(call('skill.load', { id: methodSkillId(first) })), calls(call('skill.load', { id: methodSkillId(second) })), answer()];
    const app = appAt(root, { async complete(request) { seen.push(structuredClone(request)); return responses.shift()!; } });
    app.registerCard(first); app.registerCard(second);
    const run = app.createRun({ workspace: root, objective: 'Compare proposals and prepare the budget.', binding });
    expect((await app.run(run.id)).status).toBe('completed');
    expect(seen.every(request => JSON.stringify(request.tools) === JSON.stringify(seen[0]!.tools))).toBe(true);
    const before = seen[2]!.messages.filter(message => message.role === 'tool');
    const after = seen[3]!.messages.filter(message => message.role === 'tool');
    expect(after.slice(0, before.length)).toEqual(before);
    expect(JSON.stringify(after)).toContain(first.prompt);
    expect(JSON.stringify(after)).toContain(second.prompt);
    expect(JSON.stringify(after)).toContain('no longer the active work method');
    expect(app.store.events(run.id, { types: ['method.loaded'] }).map(event => event.data.id)).toEqual([methodSkillId(first), methodSkillId(second)]);
    expect(app.store.events(run.id, { types: ['method.ended'] }).map(event => event.data.reason)).toEqual(['replaced', 'completed']);
    expect(activeMethod(app.store, run.id)).toBeUndefined();
  });

  it('does not reopen on paging, repeated loads or ordinary reference Skills', async () => {
    const root = temp(), first = method('long', 'A'.repeat(400), { skills: ['reference'] });
    const plain = { id: 'reference', description: 'Reference', content: 'Keep original evidence.', digest: digest('Keep original evidence.') };
    const app = appAt(root, scripted(calls(call('skill.load', { id: methodSkillId(first), maxChars: 256 })),
      calls(call('skill.load', { id: methodSkillId(first), offset: 256 })), calls(call('skill.load', { id: 'reference' })),
      calls(call('skill.load', { id: methodSkillId(first) })), answer()));
    app.registerSkills([plain]); app.registerCard(first);
    const main = app.parseCard('---\nschema_version: 1\nid: test/main\nversion: 1.0.0\nname: Main\ndescription: Main\ncapabilities:\n  tools: [file.read, skill.list, skill.load]\n  skills: [reference]\n---\nComplete the task.\n');
    const run = app.createRun({ workspace: root, objective: 'Inspect the figures.', binding, card: main });
    expect((await app.run(run.id)).status).toBe('completed');
    expect(app.store.events(run.id, { types: ['method.loaded'] })).toHaveLength(1);
    const results = app.store.calls(run.id).filter(item => item.name === 'skill.load').map(item => app.store.readBlob<Record<string, unknown>>(item.resultRef!));
    expect(results[0]).toMatchObject({ next: { offset: 256 }, requiredSkills: ['reference'] });
    expect(results[1]).toMatchObject({ content: 'A'.repeat(144), next: null });
    expect(results[2]).not.toHaveProperty('method');
  });

  it('keeps the active method when the next method load fails', async () => {
    const root = temp(), first = method('first'), second = method('second');
    const app = appAt(root, scripted(calls(call('skill.load', { id: methodSkillId(first) })), calls(call('skill.load', { id: methodSkillId(second), offset: 9999 })), async () => {
      expect(activeMethod(app.store, run.id)?.id).toBe(methodSkillId(first));
      expect(app.store.events(run.id, { types: ['method.ended'] })).toHaveLength(0);
      return answer();
    }));
    app.registerCard(first); app.registerCard(second);
    const run = app.createRun({ workspace: root, objective: 'Inspect figures.', binding });
    expect((await app.run(run.id)).status).toBe('completed');
    expect(app.store.events(run.id, { types: ['method.loaded'] })).toHaveLength(1);
  });

  it('records consecutive loads in one model response in request order', async () => {
    const root = temp(), first = method('one'), second = method('two');
    const app = appAt(root, scripted(calls(call('skill.load', { id: methodSkillId(first) }, 'one'), call('skill.load', { id: methodSkillId(second) }, 'two')), answer()));
    app.registerCard(first); app.registerCard(second);
    const run = app.createRun({ workspace: root, objective: 'Inspect figures.', binding });
    expect((await app.run(run.id)).status).toBe('completed');
    const results = app.store.calls(run.id).filter(item => item.name === 'skill.load').map(item => app.store.readBlob<Record<string, unknown>>(item.resultRef!));
    expect(results[1]!.methodNotice).toContain(methodSkillId(first));
    expect(app.store.events(run.id, { types: ['method.loaded'] }).map(event => event.data.id)).toEqual([methodSkillId(first), methodSkillId(second)]);
  });

  it('restores the method from disk after interruption without another load', async () => {
    const root = temp(), card = method('resume');
    const app = appAt(root, scripted(calls(call('skill.load', { id: methodSkillId(card) })), async (_request, signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      app.coordinator.interrupt(run.id);
    })));
    app.registerCard(card);
    const run = app.createRun({ workspace: root, objective: 'Inspect figures.', binding });
    expect((await app.run(run.id)).status).toBe('interrupted');
    expect(activeMethod(app.store, run.id)?.id).toBe(methodSkillId(card));
    await app.shutdown(); applications.delete(app);
    const reopened = appAt(root, scripted(answer()));
    expect(activeMethod(reopened.store, run.id)?.id).toBe(methodSkillId(card));
    const resumed = await reopened.recover(run.id);
    expect(resumed.status).toBe('completed');
    expect(activeMethod(reopened.store, resumed.id)).toBeUndefined();
  });

  it('keeps legacy cards out of the method catalog and freezes available versions per session', async () => {
    const root = temp(), first = method('pinned');
    const legacy = method('legacy', undefined, { execution: undefined });
    const app = appAt(root, scripted(calls(call('skill.list', {})), answer()));
    app.registerCard(first); app.registerCard(legacy);
    const run = app.createRun({ workspace: root, objective: 'Inspect figures.', binding });
    app.registerCard(method('pinned', 'A newer method.', { version: '2.0.0' }));
    expect((await app.run(run.id)).status).toBe('completed');
    const listed = app.store.calls(run.id).find(item => item.name === 'skill.list')!;
    expect(app.store.readBlob<{ skills: { id: string }[] }>(listed.resultRef!).skills.map(skill => skill.id)).toEqual([methodSkillId(first)]);
  });

  it('reports incompatible method contracts instead of silently dropping requirements', async () => {
    const root = temp(), card = method('contract', undefined, { inputs: [{ name: 'budget', kind: 'text', required: true }] });
    const app = appAt(root, scripted(calls(call('skill.list', {})), calls(call('skill.load', { id: methodSkillId(card) })), answer()));
    app.registerCard(card);
    const run = app.createRun({ workspace: root, objective: 'Inspect figures.', binding });
    expect((await app.run(run.id)).status).toBe('completed');
    const listed = app.store.calls(run.id).find(item => item.name === 'skill.list')!;
    expect(app.store.readBlob(listed.resultRef!)).toMatchObject({ skills: [], unavailableMethods: [{ id: methodSkillId(card), reason: expect.stringContaining('named inputs') }] });
    expect(app.store.events(run.id, { types: ['method.loaded'] })).toHaveLength(0);
  });

  it('honors inline-only cards while preserving independently runnable cards', () => {
    const root = temp(), inline = method('inline'), both = method('both', undefined, { execution: { modes: ['inline', 'child'] } });
    const app = appAt(root, scripted());
    app.registerCard(inline); app.registerCard(both);
    const run = app.createRun({ workspace: root, objective: 'Inspect figures.', binding });
    expect(() => app.spawnAgent(run.sessionId, { agent: inline.id, objective: 'Inspect figures.' })).toThrow('inline method loading only');
    expect(app.spawnAgent(run.sessionId, { agent: both.id, objective: 'Inspect figures.' }).card.id).toBe(both.id);
  });

  it('does not silently reactivate a finished method on a new user follow-up', async () => {
    const root = temp(), card = method('finished');
    const app = appAt(root, scripted(calls(call('skill.load', { id: methodSkillId(card) })), answer(), async request => {
      expect(JSON.stringify(request.messages)).not.toContain(card.prompt);
      return answer();
    }));
    app.registerCard(card);
    const run = app.createRun({ workspace: root, objective: 'Inspect figures.', binding });
    await app.run(run.id);
    const followup = app.submitInput(run.id, 'Explain the result briefly.', { mode: 'follow_up' });
    expect(activeMethod(app.store, followup.id)).toBeUndefined();
    const completed = await app.run(followup.id);
    expect(completed.status, completed.error).toBe('completed');
    expect(app.store.events(followup.id, { types: ['method.loaded'] })).toHaveLength(0);
  });

  it('resumes after a committed method load without duplicating its lifecycle', async () => {
    const root = temp(), first = method('before-stop'), second = method('after-stop');
    const app = appAt(root, scripted(calls(call('skill.load', { id: methodSkillId(first) })), calls(call('skill.load', { id: methodSkillId(second) })), answer()));
    app.registerCard(first); app.registerCard(second);
    const run = app.createRun({ workspace: root, objective: 'Inspect figures.', binding });
    const unsubscribe = app.store.subscribe(event => {
      if (event.runId === run.id && event.type === 'method.loaded') app.coordinator.interrupt(run.id);
    });
    expect((await app.run(run.id)).status).toBe('interrupted');
    unsubscribe();
    const resumed = await app.recover(run.id);
    expect(resumed.status, resumed.error).toBe('completed');
    const ids = [...new Set([run.id, resumed.id])];
    expect(ids.flatMap(id => app.store.events(id, { types: ['method.loaded'] })).map(event => event.data.id)).toEqual([methodSkillId(first), methodSkillId(second)]);
    const result = app.store.calls(resumed.id).find(item => item.name === 'skill.load' && app.store.readBlob<{ id: string }>(item.resultRef!).id === methodSkillId(second))!;
    expect(app.store.readBlob<{ methodNotice: string }>(result.resultRef!).methodNotice).toContain(methodSkillId(first));
  });
});
