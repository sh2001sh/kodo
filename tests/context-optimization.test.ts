import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { attachment, attachmentBody, attachmentKind } from '../src/runtime/attachments.js';
import { compareContextPrefixes, measureContextLayers } from '../src/runtime/context-inspection.js';
import { beforeWriteInstructions, initialInstructions, refreshInstructions } from '../src/runtime/instruction-layer.js';
import { discoverInstructions } from '../src/runtime/project-instructions.js';
import { stateFrame } from '../src/runtime/state-frame.js';
import { KodoError } from '../src/runtime/types.js';
import type { Message, Provider } from '../src/runtime/types.js';
import { answer, call, fixture, temp } from './helpers.js';

type Request = Parameters<Provider['complete']>[0];
const truncated = (): KodoError => new KodoError('MODEL_INCOMPLETE', 'output limit reached', { outputLimit: true, usageKnownZero: true });

describe('optimization context integration', () => {
  it('always sends an unstored state frame and records additive layer accounting without host budgets', async () => {
    let captured!: Request;
    const { app, runId } = fixture({ async complete(request) { captured = request; return answer(); } });
    const result = await app.run(runId);
    expect(result.status, result.error).toBe('completed');
    expect(attachmentKind(captured.messages.at(-1)!)).toBe('state');
    expect(app.store.readBlob<Message[]>(result.contextRef).some(message => attachmentKind(message) === 'state')).toBe(false);
    const measured = measureContextLayers(app.store, result, captured.messages, captured.tools);
    expect(measured.layers.L7).toBeGreaterThan(0);
    expect(Object.values(measured.layers).reduce((sum, count) => sum + count, 0) + measured.tools + measured.protocolAndCalibration).toBe(measured.estimatedInputTokens);
    expect(app.store.latestEvent(runId, { types: ['context.request_measured'] })?.data).toMatchObject({ estimated: true, instructionsDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it('queries at most five status rows without enumerating the complete call history', () => {
    const { app, runId } = fixture();
    const run = app.store.run(runId);
    for (let index = 0; index < 40; index++) app.store.putCall({ id: `pending-${index}`, runId, step: index, kind: 'tool', name: 'file.read', effect: 'read', status: index < 20 ? 'failed' : 'unknown', reservedTokens: 0, requestRef: app.store.blob(call('file.read', { path: 'a.txt' })) });
    const all = vi.spyOn(app.store, 'calls').mockImplementation(() => { throw new Error('full scan was used'); });
    try {
      const value = JSON.parse(attachmentBody(stateFrame(app.coordinator, run, app.store.session(run.sessionId), { inputTokens: 800, triggerTokens: 700, hardCapacityTokens: 1000 }))) as { calls: { status: string }[]; moreCalls: number; context: unknown };
      expect(value.calls).toHaveLength(5);
      expect(value.calls.every(item => item.status === 'unknown')).toBe(true);
      expect(value.moreCalls).toBe(35);
      expect(value.context).toMatchObject({ inputTokens: 800, triggerTokens: 700, hardCapacityTokens: 1000 });
    } finally { all.mockRestore(); }
  });

  it('retries a truncated response unchanged once then guides a smaller response without compaction', async () => {
    const requests: Request[] = [];
    const { app, runId } = fixture({ async complete(request) {
      requests.push(structuredClone(request));
      if (requests.length < 3) throw truncated();
      return answer('small completed response');
    } });
    const result = await app.run(runId);
    expect(result.status, result.error).toBe('completed');
    expect(requests).toHaveLength(3);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2]!.messages.slice(0, -2)).toEqual(requests[0]!.messages.slice(0, -1));
    expect(attachmentKind(requests[2]!.messages.at(-2)!)).toBe('notice');
    expect(requests[2]!.messages.at(-2)!.content).toContain('Split this step');
    expect(attachmentKind(requests[2]!.messages.at(-1)!)).toBe('state');
    expect(app.store.countEvents(runId, { types: ['model.output_guided'] })).toBe(1);
    expect(app.store.countEvents(runId, { types: ['context.overflow_recovery', 'context.compacted', 'context.summary.started'] })).toBe(0);
  });

  it('stops with a handoff if the guided output is truncated too', async () => {
    let attempts = 0;
    const { app, runId } = fixture({ async complete() { attempts++; throw truncated(); } });
    const result = await app.run(runId);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('MODEL_OUTPUT_LIMIT');
    expect(attempts).toBe(3);
    expect(app.store.latestEvent(runId, { types: ['run.handoff'] })?.data.code).toBe('MODEL_OUTPUT_LIMIT');
  });

  it('discovers a first-write directory before changing files and does not rediscover the same revision', () => {
    const { app, runId, root } = fixture();
    mkdirSync(path.join(root, 'module'));
    writeFileSync(path.join(root, 'module', 'AGENTS.md'), 'Use the module formatter.', 'utf8');
    const run = app.store.run(runId);
    const request = call('file.apply_patch', { path: 'module/new.ts', content: 'export const value = 1;' });
    const block = app.store.transaction(() => beforeWriteInstructions(app.store, run, app.store.session(run.sessionId), [request]));
    expect(block?.content).toContain('Use the module formatter.');
    expect(block?.content).toContain('trigger="before_write"');
    expect(beforeWriteInstructions(app.store, app.store.run(runId), app.store.session(run.sessionId), [request])).toBeUndefined();
  });

  it('appends changed and removed instruction revisions while keeping the frozen prefix', () => {
    const { app, runId, root } = fixture();
    const file = path.join(root, 'AGENTS.md');
    writeFileSync(file, 'Use formatter A.', 'utf8');
    const original = app.store.run(runId);
    const loaded = initialInstructions(root, { global: false, capacityBytes: 20_000 });
    app.store.updateRun(runId, { instructions: loaded.state });
    const frozen = app.store.run(runId).contextRef;
    writeFileSync(file, 'Use formatter B.', 'utf8');
    const block = refreshInstructions(app.store, app.store.run(runId), app.store.session(original.sessionId));
    expect(block?.content).toContain('Use formatter B.');
    expect(block?.content).toContain('replaces="previous project instruction revision"');
    expect(app.store.run(runId).contextRef).toBe(frozen);
    unlinkSync(file);
    expect(refreshInstructions(app.store, app.store.run(runId), app.store.session(original.sessionId))?.content).toContain('were removed');
  });

  it('bounds instructions including headings and notes even when the allowance is exhausted', () => {
    const root = temp();
    writeFileSync(path.join(root, 'AGENTS.md'), 'R'.repeat(30_000), 'utf8');
    for (const maxBytes of [0, 40, 256, 1024, 16_384]) {
      const chain = discoverInstructions({ workspace: root, directories: [], includeRoot: true, global: false, loaded: new Set(), maxBytes });
      expect(chain.bytes).toBeLessThanOrEqual(maxBytes);
    }
  });

  it('loads project memory only when the host opts in', () => {
    const root = temp();
    mkdirSync(path.join(root, '.kodo', 'memory'), { recursive: true });
    writeFileSync(path.join(root, '.kodo', 'memory', 'lessons.md'), 'PROJECT-MEMORY', 'utf8');
    expect(initialInstructions(root, { global: false, capacityBytes: 10_000 }).chain.text).not.toContain('PROJECT-MEMORY');
    expect(initialInstructions(root, { global: false, capacityBytes: 10_000, memory: true }).chain.text).toContain('PROJECT-MEMORY');
  });

  it('reports later equal layers separately from the shorter reusable prefix', () => {
    const prefix = (identity: string): Message[] => [{ role: 'system', content: `Shared kernel. Run ID: ${identity}` }, { role: 'system', content: 'Agent method configuration: common' }, attachment('project-instructions', 'same instructions'), attachment('environment', `scope ${identity}`), { role: 'user', content: `task ${identity}` }];
    const compared = compareContextPrefixes({ tools: [], messages: prefix('parent') }, { tools: [], messages: prefix('child') });
    expect(compared.layersEqual).toMatchObject({ L1: false, L2: true, L3: true, L4: false, L5: false });
    expect(compared.sharedRuleChars).toBe('Shared kernel. Run ID: '.length);
    expect(compared.note).toContain('not provider wire tokens or cache hits');
  });

  it('records the child first-request comparison against the actual persisted parent request', async () => {
    const { app, runId } = fixture();
    const parent = app.store.run(runId);
    const parentRequest: Request = { binding: parent.binding, messages: app.store.readBlob(parent.contextRef), tools: [], maxOutputTokens: 512 };
    const parentRequestRef = app.store.blob(parentRequest);
    app.store.putCall({ id: 'fixture-parent-call', runId, step: 0, kind: 'model', name: parent.binding.model, status: 'succeeded', effect: 'read', requestRef: parentRequestRef, resultRef: app.store.blob(answer()), reservedTokens: 1000 });
    const child = app.store.transaction(() => app.coordinator.mailbox.execute(parent, 'fixture-spawn', 'spawn_agent', { objective: 'Review the assigned module.' })) as { id: string };
    const finished = await app.coordinator.wake(child.id);
    expect(finished.status, finished.error).toBe('completed');
    const event = app.store.latestEvent(child.id, { types: ['child.prefix_shared'] });
    expect(event?.data).toMatchObject({ parentRunId: runId, parentRequestRef, layersEqual: { L1: false, L2: true, L5: false }, toolsEqual: false });
    expect(app.store.countEvents(child.id, { types: ['child.prefix_shared'] })).toBe(1);
  });
});
