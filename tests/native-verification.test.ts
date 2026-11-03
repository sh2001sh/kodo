import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Application } from '../src/application/index.js';
import * as processTools from '../src/tools/index.js';
import type { VerificationPolicy } from '../src/tools/verify.js';
import { validateVerificationPolicy } from '../src/cli/host-state.js';
import { binding, scripted, temp } from './helpers.js';

const verification: VerificationPolicy = {
  enabled: true, approved: true, backend: 'native', program: process.execPath,
  args: ['-e', "console.log('TAP version 13\\nok 1 - native verification')"], parser: 'tap',
};

describe('native verification application wiring with a synthetic process runner', () => {
  it('accepts native host configuration but requires the application OS sandbox before enabling it', () => {
    expect(() => validateVerificationPolicy(verification)).not.toThrow();
    expect(() => new Application(path.join(temp(), '.state'), scripted(), undefined, { verification })).toThrow(expect.objectContaining({ code: 'VERIFY_SANDBOX' }));
  });

  it.each([true, false])('passes the configured sandbox, run scope, private storage deny and effective write=%s for every repeat', async write => {
    const workspace = temp();
    mkdirSync(path.join(workspace, 'project', 'output'), { recursive: true });
    const runner = vi.spyOn(processTools, 'runProcess').mockResolvedValue({ stdout: 'ok 1 - native verification\n', stderr: '', exitCode: 0, signal: null, truncated: false, cancelled: false, outputLimitExceeded: false });
    const app = new Application(path.join(workspace, '.state'), scripted(), undefined, {
      exploration: false, lockDirectory: false, verification, sandbox: { network: 'none', resources: { maxProcesses: 4 } },
    });
    try {
      const run = app.createRun({ objective: 'Verify the project.', workspace, binding, permissions: ['read', 'write', 'exec'], scope: { read: ['project'], write: ['project/output'] } });
      if (!write) app.store.updateRun(run.id, { permissions: ['read', 'exec'] });
      const result = await app.coordinator.tools.execute(run.id, 'verify.run', { repeat: 2 }, new AbortController().signal);
      expect(result).toMatchObject({ backend: 'native', complete: true, passed: true, flaky: false, completedRepeats: 2 });
      expect(runner).toHaveBeenCalledTimes(2);
      for (const invocation of runner.mock.calls) {
        expect(invocation.slice(0, 4)).toEqual([verification.program, verification.args, workspace, binding.apiKeyEnv]);
        expect(invocation[5]).toMatchObject({ sandbox: {
          network: 'none', resources: { maxProcesses: 4 }, workspace,
          scope: { read: ['project'], write: ['project/output'] }, write, deny: ['.state'],
        } });
      }
    } finally { runner.mockRestore(); await app.shutdown(); }
  });
});
