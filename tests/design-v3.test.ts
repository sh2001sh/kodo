import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { compactionGeometry, defaultTriggerRatio, geometryShares, validateCompactionPolicy } from '../src/runtime/compaction-trigger.js';
import { deliverableStatus, describeUnsatisfied } from '../src/runtime/deliverables.js';
import { deliveryStatePrefix, renderDeliveryState } from '../src/runtime/delivery-state.js';
import { summaryMarker, summarySections } from '../src/runtime/summary-schema.js';
import { maskToolMessage, prunedMarker, pruneToolMessage, pruneThresholdChars } from '../src/runtime/tool-result-prune.js';
import type { ToolResultSource } from '../src/runtime/tool-result-prune.js';
import { KodoError } from '../src/runtime/types.js';
import type { Message } from '../src/runtime/types.js';
import { answer, call, calls, fixture, scripted, temp } from './helpers.js';

const source: ToolResultSource = { archivedRef: 'archive-ref', offsetOf: () => 7, call: () => undefined };

describe('ratio compaction geometry', () => {
  it('triggers at 0.8 of the effective window by default', () => {
    const geometry = compactionGeometry({}, { maxContextTokens: 65_536, outputReserve: 16_384, safeInput: 48_000 });
    expect(defaultTriggerRatio).toBe(0.8);
    expect(geometry).toMatchObject({ mode: 'ratio', effectiveTokens: 49_152, triggerTokens: 39_321, targetTokens: 24_576, maxSummaryTokens: 8192 });
    expect(geometryShares(geometry, 3_000)).toEqual({ recentTokens: 9_830, installTokens: 24_576, debounceTokens: 34_406 });
  });

  it('never triggers above the safe input and keeps the legacy work budget', () => {
    expect(compactionGeometry({ triggerRatio: 0.95 }, { maxContextTokens: 65_536, outputReserve: 16_384, safeInput: 40_000 }).triggerTokens).toBe(40_000);
    expect(compactionGeometry({ workInputTokens: 20_000 }, { maxContextTokens: 65_536, outputReserve: 16_384, safeInput: 48_000 })).toMatchObject({ mode: 'work', triggerTokens: 20_000, targetTokens: 14_000, maxSummaryTokens: 4096 });
  });

  it('validates the policy shape', () => {
    expect(() => validateCompactionPolicy({ strategy: 'summary', triggerRatio: 0.8 })).not.toThrow();
    for (const policy of [{ strategy: 'summary', triggerRatio: 0.4 }, { strategy: 'summary', triggerRatio: 0.8, workInputTokens: 4096 }, { strategy: 'summary', extra: 1 }]) {
      expect(() => validateCompactionPolicy(policy as never)).toThrow('compaction requires');
    }
  });
});

describe('tool result pruning', () => {
  it('keeps head and tail with an exact archive pointer and skips small results', () => {
    const content = `HEAD${'x'.repeat(pruneThresholdChars)}TAIL`;
    const pruned = pruneToolMessage({ role: 'tool', tool_call_id: 'a', content }, source)!;
    expect(pruned.content.startsWith('HEAD')).toBe(true);
    expect(pruned.content.endsWith('TAIL')).toBe(true);
    expect(pruned.content).toContain(prunedMarker);
    expect(pruned.content).toContain('"ref":"archive-ref","offset":7');
    expect(pruned.content.length).toBeLessThan(content.length);
    expect(pruneToolMessage({ role: 'tool', tool_call_id: 'b', content: 'short' }, source)).toBeUndefined();
  });

  it('masks once and never wraps an existing mask', () => {
    const message: Message = { role: 'tool', tool_call_id: 'c', content: JSON.stringify({ path: 'a.ts', content: 'y'.repeat(2_000) }) };
    const masked = maskToolMessage(message, [message], source)!;
    expect(JSON.parse(masked.content)).toMatchObject({ contextHidden: true, path: 'a.ts', read: { args: { ref: 'archive-ref', offset: 7 } } });
    expect(maskToolMessage(masked, [masked], source)).toBeUndefined();
  });
});

describe('deliverables and the delivery state block', () => {
  it('checks paths, size floors and excluded scratch patterns against the workspace', () => {
    const root = temp();
    mkdirSync(path.join(root, 'test'));
    writeFileSync(path.join(root, 'DELIVERY.md'), 'short');
    writeFileSync(path.join(root, 'test', 'tmp-probe.ts'), 'scratch');
    const statuses = deliverableStatus(root, [{ path: 'DELIVERY.md', minBytes: 200 }, { pattern: 'test/**/*.ts', exclude: ['**/tmp-*'] }], 0);
    expect(statuses.map(item => item.status)).toEqual(['empty', 'missing']);
    expect(describeUnsatisfied(statuses)).toEqual(['DELIVERY.md: too small (5 bytes; needs at least 200)', 'test/**/*.ts: missing']);
    writeFileSync(path.join(root, 'test', 'real.test.ts'), 'real');
    expect(deliverableStatus(root, [{ pattern: 'test/**/*.ts', exclude: ['**/tmp-*'] }], 0)[0]).toMatchObject({ status: 'satisfied', matches: ['test/real.test.ts'] });
  });

  it('puts the authoritative delivery state ahead of the summary text', () => {
    const state = renderDeliveryState({ objective: 'Fix it', deliverables: [{ label: 'DELIVERY.md', status: 'missing', bytes: 0, minBytes: 200, matches: [] }], filesChanged: ['src/a.ts'], commands: [{ command: 'npm test', exitCode: 1, status: 'succeeded' }], unresolvedFailures: [] });
    const marker = summaryMarker({ text: 'Goal: fix', archivedRef: 'ref', coveredOffsets: [1, 2], droppedGroups: 0, deliveryState: state });
    expect(marker.indexOf(deliveryStatePrefix)).toBeLessThan(marker.indexOf('Goal: fix'));
    expect(marker).toContain('- DELIVERY.md: missing');
    expect(marker).toContain('- npm test => exit 1');
    expect(summarySections).toContain('Deliverables');
  });
});

describe('context overflow recovery', () => {
  it('forces one compaction and retries after a provider context error', async () => {
    let attempts = 0;
    const { app, runId } = fixture({ async complete() {
      if (++attempts === 1) throw new KodoError('MODEL_CONTEXT', 'prompt is too long', { usageKnownZero: true });
      return answer('recovered');
    } });
    const run = await app.run(runId);
    expect(run.status, run.error).toBe('completed');
    expect(app.store.events(runId).filter(event => event.type === 'context.overflow_recovery')).toHaveLength(1);
  });

  it('stops with a handoff report when the request still overflows after forced compaction', async () => {
    const { app, runId } = fixture({ async complete() { throw new KodoError('MODEL_CONTEXT', 'prompt is too long', { usageKnownZero: true }); } });
    const run = await app.run(runId);
    expect(run.error).toContain('MODEL_CONTEXT');
    expect(run.error).toContain('handoff report');
    expect(app.store.events(runId).find(event => event.type === 'run.handoff')?.data.code).toBe('MODEL_CONTEXT');
  });
});

describe('output-limit stops', () => {
  const limit = (): KodoError => new KodoError('MODEL_INCOMPLETE', 'response stopped at the output token limit; no tools from this response were executed', { outputLimit: true });

  it('retries the same request once after an output-limit stop', async () => {
    let attempts = 0;
    const { app, runId } = fixture({ async complete() {
      if (++attempts === 1) throw limit();
      return answer('recovered');
    } });
    const run = await app.run(runId);
    expect(run.status, run.error).toBe('completed');
    const retries = app.store.events(runId).filter(event => event.type === 'model.retry');
    expect(retries).toHaveLength(1);
    expect(retries[0]!.data).toMatchObject({ reason: 'output_limit', delayMs: 0 });
  });

  it('fails after the unchanged retry and the guided request both hit the output limit', async () => {
    let attempts = 0;
    const { app, runId } = fixture({ async complete() { attempts++; throw limit(); } });
    const run = await app.run(runId);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('MODEL_INCOMPLETE');
    expect(attempts).toBe(3);
    expect(app.store.events(runId).filter(event => event.type === 'model.output_guided')).toHaveLength(1);
  });

  it('does not retry other incomplete responses', async () => {
    let attempts = 0;
    const { app, runId } = fixture({ async complete() { attempts++; throw new KodoError('MODEL_INCOMPLETE', 'response did not end normally'); } });
    expect((await app.run(runId)).status).toBe('failed');
    expect(attempts).toBe(1);
  });
});

describe('field-level tool argument errors', () => {
  it('names the failing field and returns the current hash for a malformed expectedHash', async () => {
    const { app, root, runId } = fixture(scripted(
      calls(call('file.patch', { path: 'a.txt', expectedHash: 'ab'.repeat(31), edits: [{ oldText: 'old', newText: 'new' }] })),
      async request => {
        const content = String(request.messages.findLast(message => message.role === 'tool')?.content);
        const current = createHash('sha256').update('old text').digest('hex');
        expect(content).toContain('TOOL_ARGUMENTS: arguments do not match the file.patch schema: /expectedHash must match pattern');
        expect(content).toContain('current hash of');
        expect(content).toContain(current);
        return answer();
      },
    ));
    writeFileSync(path.join(root, 'a.txt'), 'old text');
    const run = await app.run(runId);
    expect(run.status, run.error).toBe('completed');
  });

  it('reports unknown fields without a hash hint', async () => {
    const { app, runId } = fixture(scripted(
      calls(call('file.read', { path: 'a.txt', bogus: 1 })),
      async request => {
        const content = String(request.messages.findLast(message => message.role === 'tool')?.content);
        expect(content).toContain('unknown field');
        expect(content).toContain('bogus');
        expect(content).not.toContain('current hash');
        return answer();
      },
    ));
    expect((await app.run(runId)).status).toBe('completed');
  });
});
