import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Application } from '../src/application/index.js';
import { runBudget } from '../src/runtime/coordinator.js';
import { workspacesOverlap } from '../src/runtime/paths.js';
import { estimateInputTokens, estimateTextTokens } from '../src/runtime/context-tokens.js';
import { digest } from '../src/storage/index.js';
import { KodoError } from '../src/runtime/types.js';
import type { Call, Message } from '../src/runtime/types.js';
import { answer, binding, call, calls, fixture, temp } from './helpers.js';

describe('completion across overlapping workspaces', () => {
  it.each(['parent', 'child'] as const)('rejects a stale pass when the verifier workspace is the %s directory', async verifierDirectory => {
    const root = temp();
    const nested = path.join(root, 'nested');
    mkdirSync(nested);
    const target = path.join(nested, 'delivery.txt');
    writeFileSync(target, 'good');
    let writerSteps = 0;
    const app = new Application(path.join(root, 'state'), { async complete(request) {
      if (request.messages.some(message => message.role === 'user' && message.content === 'Writer')) {
        const file = verifierDirectory === 'parent' ? 'delivery.txt' : 'nested/delivery.txt';
        if (writerSteps++ === 0) return calls(call('file.read', { path: file }));
        return writerSteps === 2 ? calls(call('file.apply_patch', { path: file, expectedHash: digest('good'), content: 'bad' })) : answer('written');
      }
      return answer('candidate');
    } }, undefined, { agentFactors: { D: false, E: false, B: false } });
    try {
      const verifier = app.createRun({ objective: 'Verifier', workspace: verifierDirectory === 'parent' ? root : nested, binding });
      const writer = app.createRun({ objective: 'Writer', workspace: verifierDirectory === 'parent' ? nested : root, binding, permissions: ['read', 'write'] });
      let checks = 0;
      app.setCompletionValidator(verifier.id, async () => {
        const passed = readFileSync(target, 'utf8') === 'good';
        if (++checks === 1) {
          // The writer starts and finishes after the validator observes good bytes.
          await app.coordinator.wake(writer.id);
          expect(app.store.run(writer.id).status).toBe('completed');
        }
        return { passed };
      });
      expect(await app.run(verifier.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('QUALITY_FAILED') });
      expect(readFileSync(target, 'utf8')).toBe('bad');
      expect(app.store.events(verifier.id).filter(event => event.type === 'completion.checked').map(event => event.data.qualityPassed)).toEqual([false, false, false]);
    } finally { await app.shutdown(); }
  });

  it('treats unresolved terminal writes in a nested session as pending', async () => {
    const { app, root, runId } = fixture({ async complete() { return answer('candidate'); } });
    const nested = path.join(root, 'nested');
    mkdirSync(nested);
    const writer = app.createRun({ objective: 'Writer', workspace: nested, binding, permissions: ['read', 'write'] });
    app.store.updateRun(writer.id, { status: 'failed', error: 'UNKNOWN_WRITE: interrupted write' });
    const uncertain: Call = { id: 'uncertain-nested', runId: writer.id, step: 0, kind: 'tool', name: 'process.exec', effect: 'write', effectState: 'started', status: 'unknown', reservedTokens: 0, requestRef: app.store.blob({}) };
    app.store.putCall(uncertain);
    app.setCompletionValidator(runId, () => ({ passed: true }));
    expect(await app.run(runId)).toMatchObject({ status: 'failed', error: expect.stringContaining('QUALITY_FAILED') });
    expect(app.store.events(runId).filter(event => event.type === 'completion.checked').every(event => event.data.qualityPassed === false)).toBe(true);
  });

  it('does not confuse sibling directory prefixes with containment', () => {
    const root = path.resolve('workspace');
    expect(workspacesOverlap(root, root)).toBe(true);
    expect(workspacesOverlap(root, path.join(root, 'nested'))).toBe(true);
    expect(workspacesOverlap(path.join(root, 'nested'), root)).toBe(true);
    expect(workspacesOverlap(root, `${root}-sibling`)).toBe(false);
  });

  it('keeps unresolved writes in a sibling workspace outside acceptance', async () => {
    const root = temp();
    const left = path.join(root, 'left');
    const sibling = path.join(root, 'left-sibling');
    mkdirSync(left);
    mkdirSync(sibling);
    const app = new Application(path.join(root, 'state'), { async complete() { return answer('candidate'); } }, undefined, { agentFactors: { D: false, E: false, B: false } });
    try {
      const verifier = app.createRun({ objective: 'Verifier', workspace: left, binding });
      const writer = app.createRun({ objective: 'Writer', workspace: sibling, binding });
      app.store.updateRun(writer.id, { status: 'failed' });
      app.store.putCall({ id: 'sibling-unknown', runId: writer.id, step: 0, kind: 'tool', name: 'process.exec', effect: 'write', status: 'unknown', effectState: 'started', requestRef: app.store.blob({}), reservedTokens: 0 });
      app.setCompletionValidator(verifier.id, () => ({ passed: true }));
      expect((await app.run(verifier.id)).status).toBe('completed');
    } finally { await app.shutdown(); }
  });

  it('cancels promptly when a host validator does not observe its signal', async () => {
    const { app, runId } = fixture();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let validatorSignal: AbortSignal | undefined;
    app.setCompletionValidator(runId, ({ signal }) => {
      validatorSignal = signal;
      entered();
      return new Promise(() => {});
    });
    const running = app.run(runId);
    await started;
    app.coordinator.cancel(runId);
    expect((await running).status).toBe('cancelled');
    expect(validatorSignal!.aborted).toBe(true);
    expect(app.store.events(runId).some(event => event.type === 'completion.checked')).toBe(false);
  });

  it('bounds host validation by the session tool timeout', async () => {
    const { app, root } = fixture();
    const run = app.createRun({ objective: 'Bounded validation', workspace: root, binding, budget: { toolTimeoutMs: 20 } });
    let validatorSignal: AbortSignal | undefined;
    app.setCompletionValidator(run.id, ({ signal }) => {
      validatorSignal = signal;
      return new Promise(() => {});
    });
    expect(await app.run(run.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('VALIDATION_TIMEOUT') });
    expect(validatorSignal!.aborted).toBe(true);
  });
});

describe('per-run capacities', () => {
  it('uses approved run capacities instead of its parent default window', () => {
    const { app, runId } = fixture();
    const main = app.store.run(runId);
    const session = app.store.session(main.sessionId);
    const child = { ...main, modelLimits: { context: 1_000_000, output: 65_000, source: 'binding' as const } };
    expect(runBudget(child, session)).toMatchObject({ maxContextTokens: 1_000_000, maxOutputTokens: 65_000 });
    expect(runBudget(child, { ...session, modelBudgetCeilings: { maxContextTokens: 32_000, maxOutputTokens: 4_000 } })).toMatchObject({ maxContextTokens: 32_000, maxOutputTokens: 4_000 });
    expect(runBudget({ ...main, modelLimits: undefined }, session)).toEqual(session.budget);
  });
});

describe('registered effect lifecycle', () => {
  it.each(['MCP_TRANSPORT', 'PROCESS_START'])('keeps started custom writes unknown after %s errors without pausing peers', async code => {
    let steps = 0;
    let peerId = '';
    const { app, root, runId } = fixture({ async complete(request) {
      if (steps++ === 0) return calls(call('custom.write', {}));
      expect(app.store.run(peerId)).toMatchObject({ status: 'queued', cancelRequested: false });
      if (steps === 2) return calls(call('file.read', { path: 'unrelated.txt' }));
      const observation = request.messages.findLast(message => message.role === 'tool' && message.tool_call_id === 'file.read');
      expect(observation?.content).toContain('independent evidence');
      return answer('Independent reading completed; the extension write still needs host reconciliation.');
    } });
    writeFileSync(path.join(root, 'unrelated.txt'), 'independent evidence');
    app.registerTool({ name: 'custom.write', description: 'Write through a host extension.', permission: 'write', effect: 'write', writeScope: () => ['effect.txt'], parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: () => {
      writeFileSync(path.join(root, 'effect.txt'), 'applied');
      throw new KodoError(code, 'connection stopped after an external side effect');
    } });
    const main = app.store.run(runId);
    const allowed = [...main.card.tools, 'custom.write'];
    app.store.updateRun(runId, { card: { ...main.card, tools: allowed }, toolBindings: app.coordinator.tools.bindingSnapshot(allowed) });
    const peer = app.store.transaction(() => app.coordinator.mailbox.execute(app.store.run(runId), 'spawn-peer', 'spawn_agent', { objective: 'Peer reader', permissions: ['read'] })) as { id: string };
    peerId = peer.id;
    // Independent reads continue, but a final candidate cannot settle unknown effects.
    expect(await app.coordinator.wake(runId)).toMatchObject({ status: 'failed', error: expect.stringMatching(/^UNKNOWN_WRITE:/) });
    expect(readFileSync(path.join(root, 'effect.txt'), 'utf8')).toBe('applied');
    expect(app.store.calls(runId).find(item => item.name === 'custom.write')).toMatchObject({ status: 'unknown', effectState: 'started' });
    expect(app.store.calls(runId).find(item => item.name === 'file.read')).toMatchObject({ status: 'succeeded' });
    expect(() => app.coordinator.tools.assertWriteScope(runId, [path.join(root, 'effect.txt')])).toThrowError(expect.objectContaining({ code: 'UNKNOWN_WRITE' }));
    expect(() => app.coordinator.tools.assertWriteScope(runId, [path.join(root, 'unrelated.txt')])).not.toThrow();
    // The peer stays available while the host reconciles the main's unknown effect.
    expect(app.store.run(peer.id)).toMatchObject({ status: 'queued', cancelRequested: false });
    expect(app.store.latestEvent(peer.id, { types: ['run.cancel_requested'] })).toBeUndefined();
    expect(app.store.events(peer.id).filter(item => item.type === 'run.interrupted')).toHaveLength(0);
    expect(app.store.unresolvedWrites(root).map(item => item.name)).toEqual(['custom.write']);
  });

  it.each(['read', 'write'] as const)('stops an unresponsive registered %s callback without accepting its late result as success', async effect => {
    const { app, runId } = fixture({ async complete() { return calls(call('custom.pending', {})); } });
    let entered!: () => void;
    let release!: () => void;
    let returned!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const finished = new Promise<void>(resolve => { returned = resolve; });
    app.registerTool({ name: 'custom.pending', description: 'Host callback with external IO.', permission: effect, effect, parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => {
      entered();
      await pending;
      returned();
      return { late: 'successful response after cancellation' };
    } });
    const run = app.store.run(runId);
    const allowed = [...run.card.tools, 'custom.pending'];
    app.store.updateRun(runId, { card: { ...run.card, tools: allowed }, toolBindings: app.coordinator.tools.bindingSnapshot(allowed) });
    try {
      const running = app.run(runId);
      await started;
      await app.coordinator.shutdown();
      expect((await running).status).toBe('cancelled');
      const call = app.store.calls(runId).find(item => item.name === 'custom.pending')!;
      expect(call).toMatchObject({ status: effect === 'write' ? 'unknown' : 'cancelled', effectState: 'started' });
      const events = app.store.events(runId).filter(event => event.type === 'tool.finished');
      expect(events).toHaveLength(1);
      release();
      await finished;
      // Late callbacks release their locks; audited recovery owns new evidence.
      // Terminal calls and runs retain the outcome recorded at stop convergence.
      await new Promise<void>(resolve => setImmediate(resolve));
      const settled = app.store.call(call.id);
      expect(settled).toMatchObject({ status: effect === 'write' ? 'unknown' : 'cancelled', effectState: 'started' });
      expect(app.store.run(runId).status).toBe('cancelled');
      expect(app.coordinator.tools.hasInFlightEffects(runId)).toBe(false);
      if (effect === 'write') {
        expect(settled.effectOutcome).toBe('unknown');
      }
      expect(settled).toEqual(call);
      expect(app.store.events(runId).filter(event => event.type === 'tool.finished')).toEqual(events);
    } finally { release(); }
  });
});

describe('bounded token calibration', () => {
  it('does not read older request blobs when the newest measured prefix matches', () => {
    const { app, runId } = fixture();
    const run = app.store.run(runId);
    const messages = app.store.readBlob<Message[]>(run.contextRef);
    for (let index = 0; index < 32; index++) app.store.putCall({ id: `prefix-${index}`, runId, step: index, kind: 'model', name: binding.model, status: 'succeeded', effect: 'read', reservedTokens: 0,
      requestRef: app.store.blob({ binding: run.binding, messages: [...messages, ...(index === 31 ? [] : [{ role: 'user', content: `old ${index}` }])], tools: [] }),
      resultRef: app.store.blob({ ...answer(), usage: { input: 100 + index, output: 10 } }),
    });
    const blobs = vi.spyOn(app.store, 'readBlob');
    try {
      expect(estimateInputTokens(app.store, run, messages, [])).toBe(131 + estimateTextTokens('[]') + 256);
      expect(blobs).toHaveBeenCalledTimes(2);
    } finally { blobs.mockRestore(); }
  });

  it('bounds history reads, caches immutable evidence and observes changed result references', () => {
    const { app, runId } = fixture();
    const run = app.store.run(runId);
    const messages = app.store.readBlob<Message[]>(run.contextRef);
    const record = (id: string, prefix: Message[], input: number): Call => ({ id, runId, step: 0, kind: 'model', name: binding.model, status: 'succeeded', effect: 'read', reservedTokens: 0, requestRef: app.store.blob({ binding: run.binding, messages: prefix, tools: [], maxOutputTokens: 100 }), resultRef: app.store.blob({ ...answer(), usage: { input, output: 10 } }) });
    app.store.putCall(record('old-valid-prefix', messages, 1));
    for (let index = 0; index < 40; index++) app.store.putCall(record(`recent-mismatch-${index}`, [{ role: 'system', content: `Unrelated immutable request ${index}` }], 1));
    const wholeHistory = vi.spyOn(app.store, 'calls').mockImplementation(() => { throw new Error('unbounded history scan'); });
    const blobs = vi.spyOn(app.store, 'readBlob');
    try {
      expect(estimateInputTokens(app.store, run, messages, [])).toBeGreaterThanOrEqual(estimateTextTokens(JSON.stringify({ messages, tools: [] })));
      expect(blobs).toHaveBeenCalledTimes(64);
      const newest = record('new-valid-prefix', messages, 100);
      app.store.putCall(newest);
      const measured = estimateInputTokens(app.store, run, messages, []);
      blobs.mockClear();
      expect(estimateInputTokens(app.store, run, messages, [])).toBe(measured);
      expect(blobs).not.toHaveBeenCalled();
      app.store.putCall({ ...newest, resultRef: app.store.blob({ ...answer(), usage: { input: 478, output: 10 } }) });
      expect(estimateInputTokens(app.store, run, messages, [])).toBe(measured + 378);
      expect(blobs).toHaveBeenCalledTimes(2);
      expect(wholeHistory).not.toHaveBeenCalled();
    } finally { blobs.mockRestore(); wholeHistory.mockRestore(); }
  });
});
