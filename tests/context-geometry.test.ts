import { describe, expect, it } from 'vitest';
import { summaryShares } from '../src/runtime/context.js';
import type { Message, ToolSpec } from '../src/runtime/types.js';
import { fixture } from './helpers.js';
import { append, build, rounds } from './summary-helpers.js';

const hidden = (messages: Message[]): number => messages.filter(message => message.role === 'tool' && message.content.includes('"contextHidden":true')).length;

describe('compaction v3 trigger geometry', () => {
  it('plans no summary while the masked projection stays within H', () => {
    const f = fixture();
    const fixedTokens = build(f, 256_000, 'mask').estimatedInputTokens;
    append(f, rounds(12));
    const workInputTokens = fixedTokens + 8_000;
    const built = build(f, workInputTokens, 'hybrid');
    expect(built.originalInputTokens).toBeGreaterThan(workInputTokens);
    expect(built.estimatedInputTokens).toBeLessThanOrEqual(workInputTokens);
    expect(built.summaryPlan).toBeUndefined();
    expect(built.summarySkipped).toBeUndefined();
  });

  it('skips the summary when the install target minus retained context leaves under 2,048 tokens, and still masks', () => {
    const f = fixture();
    append(f, rounds(20));
    const built = build(f, 8_000, 'summary');
    expect(built.summaryPlan).toBeUndefined();
    expect(built.summarySkipped).toMatchObject({ reason: 'geometry' });
    expect(built.summarySkipped!.roomTokens).toBeLessThan(2_048);
    // A pure summary policy that cannot summarize falls back to the mask projection.
    expect(built.strategy).toBe('mask');
    expect(hidden(built.messages)).toBeGreaterThan(0);
  });

  it('computes summary room net of a large fixed prefix when the legacy work budget leaves enough space', () => {
    // About 8k tokens of tool schemas, comparable to the 20 native tools of a real run.
    const tools: ToolSpec[] = Array.from({ length: 20 }, (_, index) => ({
      name: `probe.tool_${index}`, description: 'Schema text that stays in every request. '.repeat(12),
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Workspace-relative path. '.repeat(4) } }, required: ['path'] },
    }));
    const f = fixture();
    append(f, rounds(30));
    // The current kernel prefix includes the expanded runtime/tool contract. At
    // 16 Ki tokens its retained context leaves less than the legacy 2,048-token
    // summary minimum; use 18 Ki here to test the positive net-space case. The
    // preceding test independently checks the insufficient-room fallback.
    const workInputTokens = 18_432;
    const built = build(f, workInputTokens, 'summary', tools);
    const plan = built.summaryPlan!;
    expect(built.summarySkipped).toBeUndefined();
    expect(plan.fixedTokens).toBeGreaterThan(6_000);
    const shares = summaryShares(workInputTokens, plan.fixedTokens);
    expect(shares.installTokens).toBe(plan.fixedTokens + Math.floor((workInputTokens - plan.fixedTokens) * 0.5));
    expect(plan.targetTokens).toBeGreaterThanOrEqual(2_048);
    const archive = f.app.store.readBlob<{ messages: Message[] }>(plan.archivedRef).messages;
    const tail = plan.recentOffsets.map(offset => archive[offset]!);
    expect(JSON.stringify(tail).length / 4).toBeLessThanOrEqual(shares.recentTokens + 2_000);
  });

  it('keeps mask behaviour unchanged: masks old rounds and never plans or skips a summary', () => {
    const f = fixture();
    append(f, rounds(60));
    const built = build(f, 16_000, 'mask');
    expect(built.strategy).toBe('mask');
    expect(hidden(built.messages)).toBeGreaterThan(0);
    expect(built.summaryPlan).toBeUndefined();
    expect(built.summarySkipped).toBeUndefined();
    const latest = built.messages.find(message => message.role === 'tool' && message.tool_call_id === 'round-59');
    expect(latest?.content).not.toContain('contextHidden');
  });
});
