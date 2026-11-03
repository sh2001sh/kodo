import { describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { inspectRun } from '../src/runtime/inspection.js';
import { submitReport } from '../src/runtime/report.js';
import type { Call, Run } from '../src/runtime/types.js';
import { fixture } from './helpers.js';

type Options = Parameters<typeof inspectRun>[2];
interface Page { text: string; complete: boolean; next: Options | null }
interface Observation { id: string; command: string | null; exitCode?: number | null; evidenceAvailable: boolean; stale: boolean; outputPreview: Record<string, string>; previousSameCommand: { callId: string; status: string }[] }
interface Bundle { observations: Observation[]; totalObservations: number; nextObservations: Options | null; limitations: string[]; report: { status: string }; parentJudgment: string; hostAcceptance: string }

function setup() {
  const f = fixture(undefined, ['read', 'write', 'exec']);
  const { app, runId } = f;
  const parent = app.store.run(runId);
  const child: Run = { ...parent, id: 'inspection-child', parentId: runId, status: 'completed', resultRef: app.store.blob({ text: 'Checks completed; see actual evidence.' }), card: { ...parent.card, report: [{ name: 'checks', kind: 'calls', required: true }, { name: 'unverified', kind: 'text', required: true }] } };
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
    const { app, child, record, bundle } = setup();
    record('failed-check', { stdout: '1 failed', stderr: '', exitCode: 1 });
    record('edit', { changed: true }, { name: 'file.patch' }, { path: 'src/index.ts' });
    record('passed-check', { stdout: '12 passed', stderr: '', exitCode: 0 });
    submitReport(app.store, child, { checks: ['failed-check', 'passed-check'], unverified: 'No external service checks.' });
    const result = bundle();
    expect(result).toMatchObject({ report: { status: 'complete', claims: { unverified: 'No external service checks.' } }, hostAcceptance: 'not_checked', parentJudgment: 'not_checked', totalObservations: 2 });
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
    expect(result).toMatchObject({ report: { status: 'missing' }, observations: [{ id: 'missing-result', evidenceAvailable: false, exitCode: null, stale: true }] });
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

  it('reports task generations and obsolete prerequisites without mutating the run or confusing decision versions', () => {
    const { app, runId, child, bundle, inspect } = setup();
    const session = app.store.session(child.sessionId);
    app.store.putSession({ ...session, taskProtocol: 2 });
    const items = [
      { id: 'design', content: 'Synthetic prerequisite', status: 'completed', executor: 'main' },
      { id: 'verify', content: 'Synthetic verification', status: 'in_progress', executor: 'agent', dependsOn: ['design'] },
    ];
    app.store.event(runId, 'todo.updated', { snapshot: { ownerRunId: runId, revision: 1, items, generations: { design: 1, verify: 1 } } });
    app.store.updateRun(child.id, { step: 1, todo: { id: 'verify', generation: 1, dependencies: [{ id: 'design', generation: 1 }], ready: true } });
    expect(bundle()).toMatchObject({ task: { id: 'verify', generation: 1, assignmentCurrent: true, dependenciesCurrent: true, dependencies: [{ id: 'design', acceptedGeneration: 1, currentGeneration: 1, status: 'completed', current: true }] } });
    app.store.event(runId, 'todo.updated', { snapshot: { ownerRunId: runId, revision: 2, items, generations: { design: 2, verify: 1 } } });
    const before = app.store.run(child.id);
    const events = app.store.events(child.id).length;
    expect(inspect({ section: 'acceptance' })).toMatchObject({ stale: false, decisionVersion: 0 });
    const changed = bundle();
    expect(changed).toMatchObject({ task: { assignmentCurrent: true, dependenciesCurrent: false, dependencies: [{ acceptedGeneration: 1, currentGeneration: 2, status: 'completed', current: false }] } });
    expect(changed.limitations.join(' ')).toContain('Prerequisite versions are not currently accepted');
    expect(app.store.run(child.id)).toEqual(before);
    expect(app.store.events(child.id)).toHaveLength(events);
    app.store.event(runId, 'todo.updated', { snapshot: { ownerRunId: runId, revision: 3, items: [], generations: {} } });
    expect(bundle()).toMatchObject({ task: { assignmentCurrent: false, currentGeneration: null, dependenciesCurrent: false, dependencies: [{ status: 'missing' }] } });
  });
});
