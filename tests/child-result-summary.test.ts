import { describe, expect, it, vi } from 'vitest';
import { childCompletionSummary, inspectRun } from '../src/runtime/inspection.js';
import type { Call, Run } from '../src/runtime/types.js';
import { fixture } from './helpers.js';

interface Summary {
  status: string;
  error?: string;
  acceptance: {
    parentJudgment: string;
    hostAcceptance: string;
    totalObservations: number;
    observations: { id: string; exitCode?: number | null; command: string | null; evidenceAvailable: boolean; outputComplete?: boolean; outputPreview: Record<string, string>; original: { run_id: string; call_id: string } }[];
    changes: { verifiedDiff: boolean; totalWriteCalls: number; recentWriteCalls: { roots: string[] }[] };
    task: { assignmentCurrent: boolean; dependenciesCurrent: boolean; totalDependencies: number } | null;
    unresolved: { unknownWrites: number; runningTools: number };
    limitations: string[];
  };
  inspect: { run_id: string; section: 'acceptance' };
}

function setup() {
  const f = fixture(undefined, ['read', 'write', 'exec']);
  const { app, runId } = f;
  const parent = app.store.run(runId);
  const child: Run = { ...parent, id: 'summary-child', parentId: runId, status: 'completed', resultRef: app.store.blob({ text: 'Implementation finished; external checks remain unverified.' }) };
  app.store.putRun(child);
  const record = (id: string, value: unknown, extra: Partial<Call> = {}, args: unknown = { command: 'npm test', cwd: '.' }) => {
    const requestRef = app.store.blob({ arguments: JSON.stringify(args) });
    const resultRef = value === undefined ? undefined : app.store.blob(value);
    app.store.putCall({ id, runId: child.id, step: app.store.calls(child.id).length, kind: 'tool', name: 'shell.exec', effect: 'write', status: 'succeeded', requestRef, ...(resultRef ? { resultRef } : {}), reservedTokens: 0, ...extra });
    return { requestRef, resultRef };
  };
  const summary = () => childCompletionSummary(app.store, app.store.run(runId), app.store.run(child.id)) as Summary;
  return { ...f, parent, child, record, summary };
}

describe('automatic child completion evidence', () => {
  it('includes recent command outcomes and original references without inventing acceptance or a diff', () => {
    const { app, runId, child, root, record, summary } = setup();
    record('patch', { changed: true }, { name: 'file.apply_patch', effectRoots: [`${root}/src`] }, { patch: 'fixture patch' });
    record('test-failure', { exitCode: 1, stdout: '1 failed', stderr: '' });
    record('test-pass', { exitCode: 0, stdout: '12 passed', stderr: '' });
    const value = summary();
    expect(value).toMatchObject({ status: 'completed', acceptance: { parentJudgment: 'not_checked', hostAcceptance: 'not_checked', totalObservations: 2, changes: { verifiedDiff: false, totalWriteCalls: 3 }, unresolved: { unknownWrites: 0, runningTools: 0 } } });
    expect(value.acceptance.observations).toMatchObject([
      { id: 'test-pass', exitCode: 0, command: '{"command":"npm test","cwd":"."}', outputPreview: { stdout: '12 passed' }, original: { run_id: child.id, call_id: 'test-pass' } },
      { id: 'test-failure', exitCode: 1 },
    ]);
    const original = inspectRun(app.store, app.store.run(runId), value.acceptance.observations[0]!.original);
    expect(original).toMatchObject({ call: { id: 'test-pass' }, exitCode: 0 });
    expect(value.acceptance.changes.recentWriteCalls[0]!.roots).toEqual([`${root}/src`]);
  });

  it('reads only the selected command payloads and leaves full output artifacts for explicit inspection', () => {
    const { app, child, record, summary } = setup();
    const old = record('old', { exitCode: 1, stdout: 'old failure' }, {}, { command: 'old test' });
    for (let index = 0; index < 3; index++) record(`recent-${index}`, { exitCode: 0, stdout: '😀'.repeat(4000), stderr: '中'.repeat(4000), truncated: true, outputArtifact: { id: 'full-output-not-expanded' } });
    const read = vi.spyOn(app.store, 'readBlob');
    const readArtifact = vi.spyOn(app.store, 'readArtifact');
    try {
      const value = summary();
      expect(value.acceptance.totalObservations).toBe(4);
      expect(value.acceptance.observations.map(item => item.id)).toEqual(['recent-2', 'recent-1', 'recent-0']);
      expect(read.mock.calls.map(args => args[0])).not.toContain(old.requestRef);
      expect(read.mock.calls.map(args => args[0])).not.toContain(old.resultRef);
      expect(readArtifact).not.toHaveBeenCalled();
      expect(JSON.stringify(value).length).toBeLessThan(9000);
      expect(value.inspect).toEqual({ run_id: child.id, section: 'acceptance' });
      for (const item of value.acceptance.observations) {
        expect(item.outputComplete).toBe(false);
        expect(item.outputPreview.stdout).not.toMatch(/[\uD800-\uDBFF]$/u);
      }
    } finally { read.mockRestore(); readArtifact.mockRestore(); }
  });

  it('reports missing results, unresolved writes and failure without running additional work', () => {
    const { app, child, record, summary } = setup();
    record('unknown', undefined, { status: 'unknown' });
    app.store.updateRun(child.id, { status: 'failed', error: 'Verification result is unavailable.' });
    const before = app.store.events(child.id);
    expect(summary()).toMatchObject({ status: 'failed', error: 'Verification result is unavailable.', acceptance: { unresolved: { unknownWrites: 1 }, observations: [{ id: 'unknown', evidenceAvailable: false, exitCode: null, outputComplete: false }] } });
    expect(app.store.events(child.id)).toEqual(before);
    app.store.updateRun(child.id, { status: 'running' });
    expect(summary()).toBeUndefined();
  });

  it('uses the recipient evidence grants and keeps ordinary read-only summaries free of command data', () => {
    const { app, runId, record, summary } = setup();
    record('command', { stdout: 'command output', exitCode: 0 });
    app.store.updateRun(runId, { permissions: ['read'] });
    expect(summary().acceptance.observations).toEqual([]);
    expect(summary().acceptance.changes.totalWriteCalls).toBe(0);
    app.store.updateRun(runId, { permissions: [] });
    expect(summary()).toMatchObject({ available: false });
  });

  it('includes settled background reads without mistaking one output page for the complete capture', () => {
    const { record, summary } = setup();
    record('background-read', { id: 'bg-fixture', state: 'exited', exitCode: 0, complete: true, stdout: 'tail only', stdoutOffset: 2000 }, { name: 'process.read', effect: 'read', evidencePermission: 'exec' }, { id: 'bg-fixture', stdoutOffset: 1991 });
    expect(summary().acceptance.observations).toMatchObject([{ id: 'background-read', exitCode: 0, outputComplete: false, outputPreview: { stdout: 'tail only' } }]);
  });
});
