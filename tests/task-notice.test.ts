import { describe, expect, it } from 'vitest';
import { boundTaskNotice, taskNoticeMaxBytes } from '../src/runtime/task-notice.js';

const size = (text: string): number => Buffer.byteLength(text, 'utf8');
function bound(notice: Record<string, unknown>, maxBytes?: number) {
  const stored: Record<string, unknown>[] = [];
  const content = boundTaskNotice(notice, full => { stored.push(full); return `artifact-${stored.length}`; }, maxBytes);
  return { content, parsed: JSON.parse(content) as Record<string, unknown> & { summary: string; truncated: { hint: string } }, stored };
}

describe('task completion notice budget', () => {
  it('sends a notice within 50 KiB unchanged and stores nothing', () => {
    const notice = { task: 'a', state: 'done', summary: 'x'.repeat(30_000), evidence: { calls: ['c'.repeat(10_000)] } };
    const { content, stored } = bound(notice);
    expect(content).toBe(JSON.stringify(notice));
    expect(stored).toHaveLength(0);
  });

  it('stores an oversized notice and keeps decision fields, a head/tail excerpt and the explorer hint', () => {
    const summary = `HEAD ${'界'.repeat(40_000)} TAIL`;
    const notice = { task: 'a', state: 'conflict', reason: 'conflict in src/a.ts', summary, integration: { status: 'conflict', files: ['src/a.ts'] } };
    const { content, parsed, stored } = bound(notice);
    expect(size(content)).toBeLessThanOrEqual(taskNoticeMaxBytes);
    expect(stored).toEqual([notice]);
    expect(parsed).toMatchObject({ task: 'a', state: 'conflict', reason: 'conflict in src/a.ts', integration: { status: 'conflict', files: ['src/a.ts'] } });
    expect(parsed.summary).toMatch(/^HEAD [\s\S]*characters omitted[\s\S]* TAIL$/u);
    expect(parsed.truncated).toMatchObject({ originalBytes: size(JSON.stringify(notice)), details: { tool: 'read', args: { artifact: 'artifact-1' } } });
    expect(parsed.truncated.hint).toContain('delegate an explorer task');
  });

  it('drops structured fields that cannot be excerpted, and never splits a surrogate pair', () => {
    const notice = { task: 'a', state: 'done', summary: '😀'.repeat(400), evidence: { log: 'e'.repeat(4000) }, integration: { files: Array.from({ length: 400 }, (_, i) => `src/file-${i}.ts`) } };
    const { content, parsed } = bound(notice, 2048);
    expect(size(content)).toBeLessThanOrEqual(2048);
    expect(parsed.evidence).toMatchObject({ omitted: true, details: { args: { artifact: 'artifact-1' } } });
    expect(parsed.integration).toMatchObject({ omitted: true });
    expect(parsed.summary).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });
});
