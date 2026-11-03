import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createVerificationTool, verificationTests } from '../src/tools/verify.js';
import type { VerificationExecutor, VerificationPolicy } from '../src/tools/verify.js';
import type { ToolExecutionContext } from '../src/tools/registry.js';
import type { ProcessOutput } from '../src/tools/index.js';
import { defaultBudget } from '../src/runtime/types.js';
import type { Run, Session } from '../src/runtime/types.js';

const policy: VerificationPolicy = { enabled: true, approved: true, backend: 'wsl', program: path.resolve('host-wsl.exe'), args: ['--distribution', 'verification', '--exec', 'npm', 'test'], parser: 'tap' };
const result = (stdout: string, exitCode = 0): ProcessOutput => ({ stdout, stderr: '', exitCode, signal: null, truncated: false, cancelled: false, outputLimitExceeded: false });
function context(): ToolExecutionContext {
  const run: Run = { id: 'verification-run', sessionId: 'verification-session', objective: 'verify', status: 'running', card: { id: 'test', version: '1', name: 'Test', prompt: 'Test', digest: 'test', tools: ['verify.run'] }, binding: { model: 'test', baseURL: 'http://localhost:1', apiKeyEnv: 'KODO_TEST_KEY' }, contextRef: 'test', step: 0, cancelRequested: false, createdAt: new Date(0).toISOString() };
  const session: Session = { id: run.sessionId, workspace: path.resolve('.'), permissions: ['exec', 'write'], budget: { ...defaultBudget, maxOutputTokens: 4096, maxContextTokens: 32768 }, tokens: 0, modelCalls: 0, toolCalls: 0, usageEstimated: false, createdAt: run.createdAt };
  return { run, session, signal: new AbortController().signal, markEffectStarted: vi.fn() };
}

describe('host verification channel with a synthetic executor', () => {
  it('requires an injected sandbox executor for native verification and never selects the host default', async () => {
    const native = { ...policy, backend: 'native' as const };
    await expect(createVerificationTool(native).execute(context(), {})).rejects.toMatchObject({ code: 'VERIFY_SANDBOX' });
    const execute = vi.fn<VerificationExecutor>().mockResolvedValue(result('ok 1 - native command\n'));
    expect(await createVerificationTool(native, execute).execute(context(), { repeat: 2 })).toMatchObject({ backend: 'native', complete: true, passed: true, completedRepeats: 2 });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not expose or start a backend without both host enablement and approval', async () => {
    const execute = vi.fn<VerificationExecutor>();
    for (const configuration of [undefined, { ...policy, enabled: false }, { ...policy, approved: false }]) {
      const tool = createVerificationTool(configuration, execute);
      expect(tool.available).toBe(false);
      await expect(tool.execute(context(), {})).rejects.toThrow('host must enable and approve');
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('runs the frozen host argv and reports stable outcomes despite differing duration text', async () => {
    const mutable = structuredClone(policy);
    const execute = vi.fn<VerificationExecutor>()
      .mockResolvedValueOnce(result('TAP version 13\nok 1 - adds values\n# duration_ms 1.5\n'))
      .mockResolvedValueOnce(result('TAP version 13\nok 1 - adds values\n# duration_ms 9.1\n'));
    const tool = createVerificationTool(mutable, execute);
    mutable.args.push('changed-after-registration');
    const observed = await tool.execute(context(), { repeat: 2 });
    expect(observed).toMatchObject({ requestedRepeats: 2, completedRepeats: 2, complete: true, passed: true, flaky: false, unstableTests: [] });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0]![1]).toEqual({ program: policy.program, args: policy.args });
  });

  it('lists changed and missing tests when repetitions disagree', async () => {
    const execute = vi.fn<VerificationExecutor>()
      .mockResolvedValueOnce(result('ok 1 - stable\nok 2 - intermittent\nok 3 - sometimes present\n'))
      .mockResolvedValueOnce(result('ok 1 - stable\nnot ok 2 - intermittent\n', 1));
    expect(await createVerificationTool(policy, execute).execute(context(), { repeat: 2 })).toMatchObject({
      passed: false, flaky: true,
      unstableTests: [{ name: 'intermittent', outcomes: ['passed', 'failed'] }, { name: 'sometimes present', outcomes: ['passed', 'missing'] }],
    });
  });

  it('reports a consistently failing suite as failed without labelling it flaky', async () => {
    const execute = vi.fn<VerificationExecutor>().mockResolvedValue(result('not ok 1 - always fails\n', 1));
    expect(await createVerificationTool(policy, execute).execute(context(), { repeat: 2 })).toMatchObject({ complete: true, passed: false, flaky: false, unstableTests: [] });
  });

  it('stops repetitions when capture is incomplete instead of reporting a successful comparison', async () => {
    const execute = vi.fn<VerificationExecutor>().mockResolvedValue({ ...result('partial TAP'), outputLimitExceeded: true });
    expect(await createVerificationTool(policy, execute).execute(context(), { repeat: 3 })).toMatchObject({ complete: false, passed: false, completedRepeats: 1, effectUnknown: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('cancels an active attempt and does not start another', async () => {
    const controller = new AbortController();
    const execute = vi.fn<VerificationExecutor>().mockImplementation(async (_context, _invocation, signal) => {
      controller.abort(new Error('user stopped verification'));
      signal.throwIfAborted();
      return result('ok 1 - never reached');
    });
    await expect(createVerificationTool(policy, execute).execute({ ...context(), signal: controller.signal }, { repeat: 3 })).rejects.toThrow('user stopped verification');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('enforces per-attempt time and reports incomplete verification without repeating it', async () => {
    const execute = vi.fn<VerificationExecutor>().mockImplementation(async (_context, _invocation, signal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      return { ...result(''), cancelled: true, signal: 'SIGTERM' };
    });
    const actual = await createVerificationTool({ ...policy, timeoutMs: 10 }, execute).execute(context(), { repeat: 2 });
    expect(actual).toMatchObject({ complete: false, passed: false, completedRepeats: 1, effectUnknown: true, attempts: [{ timedOut: true, cancelled: true }] });
  });

  it('describes native incomplete effects without referring to a remote backend', async () => {
    const execute = vi.fn<VerificationExecutor>().mockResolvedValue({ ...result('partial output'), outputLimitExceeded: true });
    const actual = await createVerificationTool({ ...policy, backend: 'native' }, execute).execute(context(), { repeat: 2 });
    expect(actual).toMatchObject({ backend: 'native', completedRepeats: 1, effectUnknown: true, effectEvidence: 'Native verification stopped before complete effect evidence was recorded. Reconcile the run write scope before another overlapping write.' });
  });

  it('compares process outcomes when the host selects exit-code reporting', async () => {
    const execute = vi.fn<VerificationExecutor>().mockResolvedValueOnce(result('ready', 0)).mockResolvedValueOnce(result('failed', 1));
    expect(await createVerificationTool({ ...policy, backend: 'container', parser: 'exit-code' }, execute).execute(context(), { repeat: 2 })).toMatchObject({ backend: 'container', flaky: true, passed: false, unstableTests: [], instability: 'process outcomes changed; test names are unavailable' });
  });

  it('returns a reporter failure with the observed command result instead of losing the execution evidence', async () => {
    const execute = vi.fn<VerificationExecutor>().mockResolvedValue(result('test runner did not start', 2));
    expect(await createVerificationTool(policy, execute).execute(context(), { repeat: 2 })).toMatchObject({ complete: false, passed: false, completedRepeats: 1, attempts: [{ exitCode: 2, reportError: 'verification command did not produce TAP test outcomes', stdout: 'test runner did not start' }] });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe('verification report readers', () => {
  it('reads TAP outcomes and distinguishes skip and todo annotations', () => {
    expect(verificationTests('ok 1 - sum\nok 2 - optional # SKIP unavailable\nnot ok 3 - future # TODO pending\nok 4 - sum\n', 'tap')).toEqual([
      { name: 'sum', status: 'passed' }, { name: 'optional', status: 'skipped' }, { name: 'future', status: 'pending' }, { name: 'sum [2]', status: 'passed' },
    ]);
  });

  it('reads Vitest JSON names and rejects a missing report instead of inventing successful tests', () => {
    expect(verificationTests(JSON.stringify({ testResults: [{ name: 'math.test.ts', assertionResults: [{ fullName: 'addition sums', status: 'passed' }, { title: 'later', status: 'todo' }] }] }), 'vitest-json')).toEqual([
      { name: 'math.test.ts: addition sums', status: 'passed' }, { name: 'math.test.ts: later', status: 'pending' },
    ]);
    expect(() => verificationTests('test runner could not start', 'tap')).toThrow('did not produce TAP');
    expect(() => verificationTests('{', 'vitest-json')).toThrow('complete Vitest JSON');
  });
});
