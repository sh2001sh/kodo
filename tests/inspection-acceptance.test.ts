import { describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { childCompletionSummary, inspectRun } from '../src/runtime/inspection.js';
import type { Call, Run } from '../src/runtime/types.js';
import { fixture } from './helpers.js';

type Options = Parameters<typeof inspectRun>[2];
interface Page { text: string; complete: boolean; next: Options | null }
interface Observation { id: string; command: string | null; exitCode?: number | null; evidenceAvailable: boolean; stale: boolean; outputPreview: Record<string, string>; previousSameCommand: { callId: string; status: string }[] }
interface Bundle { observations: Observation[]; totalObservations: number; nextObservations: Options | null; limitations: string[]; parentJudgment: string; hostAcceptance: string; resultPreview: string | null }

function setup() {
  const f = fixture(undefined, ['read', 'write', 'exec']);
  const { app, runId } = f;
  const parent = app.store.run(runId);
  const child: Run = { ...parent, id: 'inspection-child', parentId: runId, status: 'completed', resultRef: app.store.blob({ text: 'Checks completed; see actual evidence.' }) };
  app.store.putRun(child);
  const record = (id: string, value: unknown, extra: Partial<Call> = {}, args: unknown = { command: 'npm test', cwd: '.' }) => {
    app.store.putCall({ id, runId: child.id, step: app.store.calls(child.id).length, kind: 'tool', name: 'shell.exec', effect: 'write', status: 'succeeded', requestRef: app.store.blob({ arguments: JSON.stringify(args) }), ...(value === undefined ? {} : { resultRef: app.store.blob(value) }), reservedTokens: 0, ...extra });
  };
  const inspect = (options: Omit<Options, 'run_id'> = {}) => inspectRun(app.store, app.store.run(runId), { run_id: child.id, ...options });
  const bundle = (options: Omit<Options, 'run_id'> = {}): Bundle => {
    let page = (inspect({ section: 'acceptance', ...options }) as { acceptance: Page }).acceptance;
    let text = page.text;
    while (page.next) {
      page = (inspectRun(app.store, app.store.run(runId), page.next) as { acceptance: Page }).acceptance;
      text += page.text;
    }
    return JSON.parse(text) as Bundle;
  };
  return { ...f, child, record, inspect, bundle };
}

describe('bounded acceptance evidence', () => {
  it('aggregates actual outcomes and repeated commands without inferring repairs or acceptance', () => {
    const { record, bundle } = setup();
    record('failed-check', { stdout: '1 failed', stderr: '', exitCode: 1 });
    record('edit', { changed: true }, { name: 'file.patch' }, { path: 'src/index.ts' });
    record('passed-check', { stdout: '12 passed', stderr: '', exitCode: 0 });
    const result = bundle();
    expect(result).toMatchObject({ hostAcceptance: 'not_checked', parentJudgment: 'not_checked', totalObservations: 2, resultPreview: 'Checks completed; see actual evidence.' });
    expect(result).not.toHaveProperty('report');
    expect(result).not.toHaveProperty('task');
    expect(result.observations).toMatchObject([
      { id: 'passed-check', command: '{"command":"npm test","cwd":"."}', exitCode: 0, outputPreview: { stdout: '12 passed' }, previousSameCommand: [{ callId: 'failed-check', status: 'succeeded', exitCode: 1 }] },
      { id: 'failed-check', exitCode: 1, outputPreview: { stdout: '1 failed' }, previousSameCommand: [] },
    ]);
    expect(result.limitations.join(' ')).toContain('does not prove a repair');
  });

  it('discloses missing results and stale decision versions instead of implying complete verification', () => {
    const { app, runId, child, record, bundle, inspect } = setup();
    record('missing-result', undefined, { status: 'failed', decisionVersion: 0 });
    const session = app.store.session(child.sessionId);
    app.store.putSession({ ...session, decisionVersion: 1 });
    app.store.updateRun(runId, { decisionVersion: 1 });
    app.store.updateRun(child.id, { status: 'failed', error: 'MODEL_INCOMPLETE: check result missing' });
    expect(inspect({ section: 'acceptance' })).toMatchObject({ status: 'failed', stale: true, error: 'MODEL_INCOMPLETE: check result missing' });
    const result = bundle();
    expect(result).toMatchObject({ observations: [{ id: 'missing-result', evidenceAvailable: false, exitCode: null, stale: true }] });
    expect(result.limitations.join(' ')).toContain('no recorded result');
    expect(result.limitations.join(' ')).toContain('not Git commits');
  });

  it('shares a batch text budget and preserves individual Unicode-safe continuation cursors', () => {
    const { record, inspect, app, runId } = setup();
    record('first', { stdout: '😀'.repeat(500), exitCode: 0 });
    record('second', { stdout: '中文'.repeat(500), exitCode: 1 });
    const batch = inspect({ call_ids: ['first', 'second'], max_chars: 256 }) as { evidence: { call: { id: string }; evidence: Page }[] };
    expect(batch.evidence.map(value => value.call.id)).toEqual(['first', 'second']);
    expect(batch.evidence.reduce((sum, value) => sum + value.evidence.text.length, 0)).toBeLessThanOrEqual(256);
    for (const item of batch.evidence) {
      let text = item.evidence.text;
      let next = item.evidence.next;
      while (next) {
        expect(next.call_id).toBe(item.call.id);
        const result = inspectRun(app.store, app.store.run(runId), next) as { evidence: Page };
        expect(result.evidence.text).not.toMatch(/[\uD800-\uDBFF]$/u);
        text += result.evidence.text;
        next = result.evidence.next;
      }
      expect(JSON.parse(text)).toMatchObject({ exitCode: item.call.id === 'first' ? 0 : 1 });
    }
  });

  it('keeps observation pagination and content pagination aligned for long output', () => {
    const { record, bundle } = setup();
    for (let index = 0; index < 10; index++) record(`check-${index}`, { stdout: '中😀'.repeat(500), exitCode: 0 });
    const first = bundle({ limit: 2, max_chars: 256 });
    expect(first.observations.map(item => item.id)).toEqual(['check-9', 'check-8']);
    expect(first.nextObservations).toMatchObject({ offset: 2, limit: 2 });
    const second = bundle({ offset: 2, limit: 2, max_chars: 256 });
    expect(second.observations.map(item => item.id)).toEqual(['check-7', 'check-6']);
    expect(second.nextObservations).toMatchObject({ offset: 4, limit: 2 });
  });

  it('uses the same evidence grants and redaction for command summaries and batches', () => {
    const { app, runId, record, bundle, inspect } = setup();
    const name = app.store.run(runId).binding.apiKeyEnv;
    const previous = process.env[name];
    process.env[name] = 'synthetic-inspection-secret';
    try {
      record('check', { stdout: process.env[name], exitCode: 0 }, {}, { command: `echo ${process.env[name]}`, privateField: 'not-a-command-field' });
      const result = bundle();
      expect(JSON.stringify(result)).not.toContain(process.env[name]);
      expect(JSON.stringify(result)).not.toContain('not-a-command-field');
      expect(result.observations[0]!.command).toContain('[REDACTED]');
      app.store.updateRun(runId, { permissions: ['read'] });
      expect(bundle().observations).toEqual([]);
      expect(() => inspect({ call_ids: ['check'] })).toThrowError(expect.objectContaining({ code: 'INSPECT_DENIED' }));
    } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
  });

  it('rejects ambiguous batch pagination and duplicated IDs before reading results', () => {
    const { record, inspect } = setup();
    record('check', { exitCode: 0 });
    expect(() => inspect({ call_ids: ['check', 'check'] })).toThrowError(expect.objectContaining({ code: 'INSPECT_ARGUMENTS' }));
    expect(() => inspect({ call_ids: ['check'], content_offset: 1 })).toThrowError(expect.objectContaining({ code: 'INSPECT_ARGUMENTS' }));
    expect(() => inspect({ call_ids: ['check'], call_id: 'check' })).toThrowError(expect.objectContaining({ code: 'INSPECT_ARGUMENTS' }));
  });

  it('exposes the aggregate through the real mailbox schema and resolves recorded paths against the shared workspace', () => {
    const { app, runId, root, child, record, inspect } = setup();
    mkdirSync(`${root}/src`, { recursive: true });
    app.store.updateRun(runId, { scope: { read: ['src'] } });
    app.store.updateRun(child.id, { scope: { read: ['src'] } });
    record('read-in-copy', { content: 'recorded code' }, { name: 'file.read', effect: 'read' }, { path: `${root}/src/index.ts` });
    expect(inspect({ call_id: 'read-in-copy' })).toMatchObject({ evidence: { text: '{"content":"recorded code"}' } });
    const parent = app.store.run(runId);
    const args = app.coordinator.mailbox.validate(parent, 'inspect_run', JSON.stringify({ run_id: child.id, section: 'acceptance' }));
    const result = app.coordinator.mailbox.execute(parent, 'inspect-summary', 'inspect_run', args) as { acceptance: Page };
    const acceptance = JSON.parse(result.acceptance.text) as Record<string, unknown>;
    expect(acceptance).toMatchObject({ parentJudgment: 'not_checked' });
    expect(acceptance).not.toHaveProperty('execution');
  });

  it('pages newest observations first and states that exit zero is not acceptance', () => {
    const { child, record, bundle } = setup();
    record('old', { exitCode: 1, stdout: 'old failure' });
    for (let index = 0; index < 3; index++) record(`recent-${index}`, { exitCode: 0, stdout: 'passed' });
    expect(bundle()).toMatchObject({ totalObservations: 4, parentJudgment: 'not_checked', hostAcceptance: 'not_checked' });
    const page = bundle({ limit: 2 });
    expect(page.observations.map(item => item.id)).toEqual(['recent-2', 'recent-1']);
    expect(page.nextObservations).toMatchObject({ run_id: child.id, section: 'acceptance', offset: 2, limit: 2 });
    expect(page.limitations.join(' ')).toContain('do not establish acceptance');
  });

  it('reports a missing child result without mutating the run', () => {
    const { app, child, inspect } = setup();
    app.store.updateRun(child.id, { resultRef: undefined, status: 'failed', error: 'Verification result is unavailable.' });
    const before = app.store.events(child.id);
    expect(inspect({ section: 'acceptance' })).toMatchObject({ status: 'failed', error: 'Verification result is unavailable.' });
    expect(app.store.events(child.id)).toEqual(before);
  });

  it('keeps explicit pages and the completion projection bounded with an inspect pointer', () => {
    const { app, runId, child, record, inspect, bundle } = setup();
    for (let index = 0; index < 12; index++) record(`many-${index}`, { exitCode: 0, stdout: 'ok '.repeat(2000) });
    const first = (inspect({ section: 'acceptance' }) as { acceptance: Page }).acceptance;
    expect(first.text.length).toBeLessThanOrEqual(8000);
    expect(bundle().observations.length).toBeLessThanOrEqual(8);
    const summary = childCompletionSummary(app.store, app.store.run(runId), app.store.run(child.id)) as { acceptance: { observations: unknown[] }; inspect: Options; note: string };
    expect(JSON.stringify(summary).length).toBeLessThan(9000);
    expect(summary.acceptance.observations.length).toBeLessThanOrEqual(3);
    expect(summary.inspect).toEqual({ run_id: child.id, section: 'acceptance' });
    expect(summary.note).toContain('not task acceptance');
    expect(summary.acceptance).not.toHaveProperty('report');
  });
});
