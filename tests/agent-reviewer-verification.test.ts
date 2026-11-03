import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Application } from '../src/application/index.js';
import { reportCompleteness } from '../src/agents/contracts.js';
import { createVerificationTool } from '../src/tools/verify.js';
import type { VerificationExecutor } from '../src/tools/verify.js';
import { answer, binding, call, calls, scripted, temp } from './helpers.js';

describe('reviewer host-approved verification', () => {
  it.skipIf(process.platform !== 'win32')('runs a fixed read-only Node TAP check and completes with its recorded call', async () => {
    const workspace = temp();
    const fixturePath = path.join(workspace, 'review.txt');
    writeFileSync(fixturePath, 'review fixture\n', 'utf8');
    writeFileSync(path.join(workspace, 'review.test.cjs'), [
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      "const { readFileSync } = require('node:fs');",
      "test('reads assigned review fixture', () => assert.equal(readFileSync('review.txt', 'utf8'), 'review fixture\\n'));",
    ].join('\n'), 'utf8');
    let childId = '';
    const app: Application = new Application(path.join(workspace, '.state'), scripted(
      calls(call('verify.run', { repeat: 1 }, 'review-check')),
      async request => {
        const observed = request.messages.findLast(message => message.role === 'tool');
        expect(JSON.parse(observed!.content!)).toMatchObject({
          backend: 'native', complete: true, passed: true,
          attempts: [{ exitCode: 0, tests: [{ name: 'reads assigned review fixture', status: 'passed' }] }],
        });
        const recorded = app.store.calls(childId).find(item => item.name === 'verify.run')!;
        expect(recorded.status).toBe('succeeded');
        return calls(call('report.submit', { fields: { findings: [], checks: [recorded.id], open_issues: [] } }, 'review-report'));
      },
      answer('The fixed read-only check passed; the structured report records its evidence.'),
    ), undefined, {
      exploration: false, lockDirectory: false, lazyTools: false,
      toolProfile: 'compact-v1', taskProtocol: 2,
      instructions: { global: false }, sandbox: { network: 'none' },
      verification: {
        enabled: true, approved: true, backend: 'native', program: process.execPath,
        args: ['--test', '--test-reporter=tap', 'review.test.cjs'], parser: 'tap', repeatLimit: 1,
      },
    });
    try {
      const parent = app.createRun({ objective: 'Review the fixture.', workspace, binding, permissions: ['read', 'write', 'exec'] });
      const child = app.spawnAgent(parent.sessionId, { agent: 'kodo/reviewer', objective: 'Run the approved fixture check and report evidence.' });
      childId = child.id;
      expect(child.permissions).toEqual(['read', 'exec']);
      expect(child.scope?.write).toEqual([]);
      expect(child.card.tools).toContain('verify.run');
      expect(child.card.tools).not.toContain('process.run');
      expect(child.card.tools).not.toContain('process.exec');

      const completed = await app.coordinator.wake(child.id);
      expect(completed.status, completed.error).toBe('completed');
      expect(completed.permissions).toEqual(child.permissions);
      expect(completed.scope).toEqual(child.scope);
      expect(app.store.session(parent.sessionId).permissions).toEqual(['read', 'write', 'exec']);
      expect(readFileSync(fixturePath, 'utf8')).toBe('review fixture\n');
      const recorded = app.store.calls(child.id).find(item => item.name === 'verify.run')!;
      expect(app.store.readBlob(completed.resultRef!)).toMatchObject({
        reportCompleteness: { status: 'complete', passed: true },
        parentJudgment: { status: 'not_checked' },
      });
      expect(reportCompleteness(app.store, completed).report?.calls).toEqual([
        expect.objectContaining({ id: recorded.id, name: 'verify.run', status: 'succeeded', passed: true }),
      ]);
    } finally { await app.shutdown(); }
  }, 60_000);

  it.each(['wsl', 'container'] as const)('rejects the unsupported %s review configuration before invoking its executor', async backend => {
    const workspace = temp();
    const app = new Application(path.join(workspace, '.state'), scripted(), undefined, {
      instructions: { global: false }, sandbox: { network: 'none' },
      verification: { enabled: true, approved: true, backend: 'native', program: process.execPath, args: ['--version'] },
    });
    try {
      const parent = app.createRun({ objective: 'Review configuration.', workspace, binding, permissions: ['read', 'write', 'exec'] });
      const child = app.spawnAgent(parent.sessionId, { agent: 'kodo/reviewer', objective: 'Review the configured verification channel.' });
      const execute = vi.fn<VerificationExecutor>();
      const markEffectStarted = vi.fn();
      const tool = createVerificationTool({ enabled: true, approved: true, backend, program: process.execPath, args: ['--version'] }, execute);
      await expect(tool.execute({ run: child, session: app.store.session(child.sessionId), signal: new AbortController().signal, markEffectStarted }, {}))
        .rejects.toMatchObject({ code: 'VERIFY_READ_ONLY' });
      expect(execute).not.toHaveBeenCalled();
      expect(markEffectStarted).not.toHaveBeenCalled();
      expect(app.store.run(child.id).scope?.write).toEqual([]);
    } finally { await app.shutdown(); }
  });
});
