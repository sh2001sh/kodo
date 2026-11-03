import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Application } from '../src/application/index.js';
import { binding, scripted, temp } from './helpers.js';

describe('native verification in the Windows OS sandbox', () => {
  it.skipIf(process.platform !== 'win32')('repeats the real Node test runner and compares its TAP outcomes', async () => {
    const workspace = temp();
    writeFileSync(path.join(workspace, 'smoke.test.cjs'), "const test = require('node:test');\nconst assert = require('node:assert/strict');\ntest('native addition', () => assert.equal(2 + 2, 4));\n", 'utf8');
    const app = new Application(path.join(workspace, '.state'), scripted(), undefined, {
      exploration: false, lockDirectory: false, sandbox: { network: 'none' },
      verification: { enabled: true, approved: true, backend: 'native', program: process.execPath, args: ['--test', '--test-reporter=tap', 'smoke.test.cjs'], parser: 'tap', repeatLimit: 2 },
    });
    try {
      const run = app.createRun({ objective: 'Run the declared verification twice.', workspace, binding, permissions: ['read', 'write', 'exec'] });
      const result = await app.coordinator.tools.execute(run.id, 'verify.run', { repeat: 2 }, new AbortController().signal);
      expect(result).toMatchObject({ backend: 'native', requestedRepeats: 2, completedRepeats: 2, complete: true, passed: true, flaky: false, unstableTests: [], attempts: [
        { attempt: 1, exitCode: 0, tests: [{ name: 'native addition', status: 'passed' }] },
        { attempt: 2, exitCode: 0, tests: [{ name: 'native addition', status: 'passed' }] },
      ] });
    } finally { await app.shutdown(); }
  }, 60_000);
});
