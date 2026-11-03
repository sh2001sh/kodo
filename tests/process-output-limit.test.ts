import { describe, expect, it, vi } from 'vitest';
import { runProcess } from '../src/tools/index.js';
import { temp } from './helpers.js';

describe('bounded process output', () => {
  it('stops at the capture ceiling and reconciles even without a caller cancellation', async () => {
    const signal = new AbortController().signal;
    const onStopped = vi.fn(async () => ({ verified: false as const, roots: [], reason: 'Unconfined fixture process; full effect coverage is unavailable.' }));
    const onSettled = vi.fn();
    const output = await runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(3 * 1024 * 1024)); setInterval(() => {}, 1000)"], temp(), '', signal, { onStopped, onSettled });
    expect(signal.aborted).toBe(false);
    expect(output).toMatchObject({ outputLimitExceeded: true, truncated: true, cancelled: true, effects: { verified: false } });
    expect(Buffer.byteLength(output.stdout)).toBe(2 * 1024 * 1024);
    expect(onStopped).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
  });
});
