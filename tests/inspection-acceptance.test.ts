import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { inspectRun } from '../src/runtime/inspection.js';
import { answer, binding, call, scripted, temp } from './helpers.js';

interface Observation { id: string; status: string; exitCode: number | null; outputComplete: boolean; evidenceAvailable: boolean; stale: boolean; outputPreview?: { stdout?: string } }
interface Bundle { observations: Observation[]; totalObservations: number; nextObservations: { run_id: string; section: 'acceptance'; offset: number; limit: number } | null; limitations: string[]; parentJudgment: string; hostAcceptance: string }

function setup() {
  const root = temp();
  const app = new Application(path.join(root, '.state'), scripted(answer('child done')), undefined, { agentFactors: { D: false, E: false, B: false }, instructions: { global: false } });
  const run = app.createRun({ objective: 'Inspect the child evidence.', workspace: root, binding, permissions: ['read', 'write', 'exec'] });
  const child = { ...run, id: 'inspection-child', parentId: run.id, status: 'completed' as const, resultRef: app.store.blob({ text: 'Checks completed; see actual evidence.' }) };
  app.store.putRun(child);
  const record = (id: string, result: unknown | undefined, status: 'succeeded' | 'failed' = 'succeeded', name = 'process.exec') => {
    app.store.putCall({ id, runId: child.id, step: 0, kind: 'tool', name, status, effect: 'read', requestRef: app.store.blob(call(name, { program: 'node', args: ['-e', 'x'] }, id)), ...(result === undefined ? {} : { resultRef: app.store.blob(result) }), reservedTokens: 0, decisionVersion: 0 });
  };
  const bundle = (options: Record<string, unknown> = {}): Bundle => inspectRun(app.store, run, { run_id: child.id, section: 'acceptance', ...options }) as Bundle;
  return { app, run, child, record, bundle };
}
describe('inspect_run acceptance evidence', () => {
  it('summarizes authorized command evidence newest first with bounded previews and an inspect pointer', () => {
    const { app, child, record, bundle } = setup();
    try {
      record('old', { exitCode: 1, stdout: 'old failure' });
      for (let index = 0; index < 3; index++) record(`recent-${index}`, { exitCode: 0, stdout: 'passed' });
      expect(bundle()).toMatchObject({ totalObservations: 4, parentJudgment: 'not_checked', hostAcceptance: 'not_checked' });
      expect(bundle().observations.every(item => item.status === 'succeeded')).toBe(true);
      const page = bundle({ limit: 2 });
      expect(page.observations.map(item => item.id)).toEqual(['recent-2', 'recent-1']);
      expect(page.nextObservations).toMatchObject({ run_id: child.id, section: 'acceptance', offset: 2, limit: 2 });
      expect(page.limitations.join(' ')).toContain('not task acceptance');
    } finally { app.close(); }
  });

  it('reports a missing child result and unresolved writes without mutating the run', () => {
    const { app, child, bundle } = setup();
    try {
      app.store.updateRun(child.id, { resultRef: undefined, status: 'failed', error: 'Verification result is unavailable.' });
      const before = app.store.events(child.id);
      expect(bundle()).toMatchObject({ error: 'Verification result is unavailable.' });
      expect(app.store.events(child.id)).toEqual(before);
    } finally { app.close(); }
  });

  it('stays bounded below the completion notification budget', () => {
    const { app, record, bundle } = setup();
    try {
      for (let index = 0; index < 12; index++) record(`many-${index}`, { exitCode: 0, stdout: 'ok '.repeat(2000) });
      expect(JSON.stringify(bundle()).length).toBeLessThan(9000);
      expect(bundle().observations.length).toBeLessThanOrEqual(8);
    } finally { app.close(); }
  });
});
