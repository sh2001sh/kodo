import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { buildContext, initialContext } from '../src/runtime/context.js';
import { childHandoffGuidance } from '../src/messaging/handoff.js';
import { toolSpecs } from '../src/runtime/step-host.js';
import type { Message } from '../src/runtime/types.js';
import { answer, binding, fixture, scripted, temp } from './helpers.js';

describe('optional handoff guidance', () => {
  it('enables handoff guidance and a complete coding loop by default for new sessions', async () => {
    const root = temp();
    const app = new Application(path.join(root, '.state'), scripted(answer()), undefined, { instructions: { global: false } });
    try {
      const run = app.createRun({ objective: 'Coordinate a bounded implementation.', workspace: root, binding, permissions: ['read', 'write', 'exec'] });
      const session = app.store.session(run.sessionId);
      expect(session.agentFactors).toEqual({ A: true, B: true, C: true, D: true, E: true });
      const messages = app.store.readBlob<Message[]>(run.contextRef);
      expect(messages[0]!.content).toContain('do not design the entire implementation first');
      const names = toolSpecs(app.coordinator, run, session).map(tool => tool.name);
      expect(names).toEqual(expect.arrayContaining(['spawn_agent', 'ask_user', 'file.read']));
      expect(names).toContain('shell.exec');
      expect(names).toContain('process.read');
      expect(names).not.toContain('process.exec');
      const child = app.spawnAgent(session.id, { objective: 'Implement the bounded module.', scope: { read: ['.'], write: ['src'] } });
      expect(toolSpecs(app.coordinator, child, session).map(tool => tool.name)).toContain('shell.exec');
      expect(app.store.readBlob<Message[]>(child.contextRef).at(-1)!.content).toContain(childHandoffGuidance(false, session.taskProtocol));
    } finally { await app.shutdown(); }
  });

  it('keeps missing D/E flags off in a saved session after reopening under enabled defaults', async () => {
    const { app, runId } = fixture(undefined, ['read', 'write', 'exec'], { instructions: { global: false } });
    const run = app.store.run(runId), session = app.store.session(run.sessionId);
    const legacy = { ...session, agentFactors: { A: true, B: false, C: true } };
    app.store.putSession(legacy);
    const originalTools = toolSpecs(app.coordinator, run, legacy);
    const directory = app.store.directory;
    await app.shutdown();
    const restored = new Application(directory, scripted(async request => {
      expect(request.tools).toEqual(originalTools);
      expect(request.tools.map(tool => tool.name)).toContain('shell.exec');
      expect(request.messages[0]!.content).not.toContain('do not design the entire implementation first');
      return answer('The original session configuration is preserved.');
    }), undefined, { instructions: { global: false } });
    try {
      expect(restored.store.session(session.id).agentFactors).toEqual(legacy.agentFactors);
      expect((await restored.run(runId)).status).toBe('completed');
      expect(restored.store.session(session.id).agentFactors).toEqual(legacy.agentFactors);
    } finally { await restored.shutdown(); }
  });

  it('keeps disabled D/E context and tool bytes identical over a frozen run', () => {
    const { app, runId } = fixture();
    const run = app.store.run(runId), session = app.store.session(run.sessionId);
    expect(session.agentFactors).toMatchObject({ D: false, E: false });
    const baseline = { A: true, B: false, C: true };
    const render = (parentId?: string, explicit = false) => initialContext(session.workspace, session.permissions, run.card, run.objective, { id: run.id, parentId }, undefined, { factors: { ...baseline, ...(explicit ? { D: false, E: false } : {}) } });
    for (const parent of [undefined, 'fixed-parent']) expect(JSON.stringify(render(parent))).toBe(JSON.stringify(render(parent, true)));
    app.store.putSession({ ...session, agentFactors: baseline });
    const before = JSON.stringify(toolSpecs(app.coordinator, run, app.store.session(session.id)));
    const request = JSON.stringify({ messages: buildContext(app.store, run, null, JSON.parse(before)).messages, tools: JSON.parse(before) });
    app.store.putSession({ ...session, agentFactors: { ...baseline, D: false, E: false } });
    expect(JSON.stringify(toolSpecs(app.coordinator, run, app.store.session(session.id)))).toBe(before);
    expect(JSON.stringify({ messages: buildContext(app.store, run, null, JSON.parse(before)).messages, tools: JSON.parse(before) })).toBe(request);
  });

  it.each([
    { A: false, B: false, C: false }, { A: false, B: true, C: false },
    { A: true, B: false, C: false }, { A: true, B: true, C: false },
    { A: false, B: false, C: true }, { A: false, B: true, C: true },
    { A: true, B: false, C: true }, { A: true, B: true, C: true },
  ])('adds focused guidance without growing schemas for %j', factors => {
    const { app, runId } = fixture(undefined, undefined, { agentFactors: factors });
    const run = app.store.run(runId), session = app.store.session(run.sessionId);
    const before = app.coordinator.mailbox.specs(run);
    app.store.putSession({ ...session, agentFactors: { ...session.agentFactors, D: true } });
    const after = app.coordinator.mailbox.specs(run);
    // 1c rewrote the spawn descriptions, so D guidance may add a bounded amount of text;
    // the request catalog must stay within the same budget class and keep identical schemas.
    expect(JSON.stringify(after).length).toBeLessThanOrEqual(JSON.stringify(before).length + 512);
    expect(after.map(spec => spec.name)).toEqual(before.map(spec => spec.name));
    for (const spec of before) {
      const next = after.find(item => item.name === spec.name)!;
      const removeDescriptions = (value: unknown): unknown => Array.isArray(value) ? value.map(removeDescriptions) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description').map(([key, item]) => [key, removeDescriptions(item)])) : value;
      expect(removeDescriptions(next.parameters)).toEqual(removeDescriptions(spec.parameters));
    }
    const context = initialContext(session.workspace, session.permissions, run.card, run.objective, run, undefined, { factors: { ...session.agentFactors, D: true, E: true } });
    expect(context[0]!.content).toContain('do not design the entire implementation first');
    expect(context[0]!.content).toContain('copy the relevant findings');
    expect(context[1]!.content).not.toContain('Use image.read');
    expect(context[1]!.content).not.toContain('shell.exec requires');
  });

  it.each([false, true])('dispatch and completion work without a selected todo with D=%s', async D => {
    const { app, runId } = fixture(scripted(answer('bounded finding')), ['read'], { agentFactors: { A: false, B: true, C: false, D } });
    const run = app.store.run(runId), mailbox = app.coordinator.mailbox;
    const args = { objective: 'Read the supplied entry', context: 'No broader investigation required', inputs: ['src/entry.ts'], permissions: ['read'], scope: { write: [] } };
    const child = mailbox.execute(run, 'dispatch', 'spawn_agent', mailbox.validate(run, 'spawn_agent', JSON.stringify(args))) as { id: string; agentId: string };
    const source = app.store.run(child.id);
    const context = app.store.readBlob<Message[]>(source.contextRef);
    expect(context.at(-1)!.content?.includes(childHandoffGuidance(true))).toBe(D);
    expect((await app.coordinator.wake(child.id))?.status ?? app.store.run(child.id).status).toBe('completed');
    const followup = mailbox.execute(run, 'followup', 'followup_task', { target: child.agentId, objective: 'Clarify the same entry', inputs: ['src/entry.ts'] }) as { id: string; agentId: string };
    const resumed = app.store.run(followup.id);
    expect(followup.agentId).toBe(child.agentId);
    expect(resumed.binding).toEqual(source.binding);
    expect(resumed.permissions).toEqual(['read']);
    expect(resumed.scope?.write).toEqual([]);
    expect(app.store.readBlob<Message[]>(resumed.contextRef).at(-1)!.content?.includes(childHandoffGuidance(true))).toBe(D);
  });

  it('gives explore the same starting rules and lets a child consume a shared artifact', async () => {
    const { app, runId } = fixture(undefined, ['read', 'write'], { agentFactors: { D: true } });
    const artifact = await app.coordinator.tools.execute(runId, 'artifact.write', { name: 'entry-facts', content: 'src/entry.ts exports parse' }, new AbortController().signal) as { id: string };
    const run = app.store.run(runId);
    const result = app.coordinator.mailbox.execute(run, 'explore', 'explore', { tasks: [{ prompt: `Confirm the facts in artifact ${artifact.id}` }] }) as { runs: { id: string }[] };
    const child = app.store.run(result.runs[0]!.id);
    expect(app.store.readBlob<Message[]>(child.contextRef).at(-1)!.content).toContain(childHandoffGuidance(true));
    const read = await app.coordinator.tools.execute(child.id, 'artifact.read', { id: artifact.id }, new AbortController().signal);
    expect(JSON.stringify(read)).toContain('src/entry.ts exports parse');
  });
});
