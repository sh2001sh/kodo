import { describe, expect, it, vi } from 'vitest';
import { createTuiInterrupt } from '../src/tui/interrupt.js';

describe('TUI Ctrl+C gesture', () => {
  it('interrupts once and explains the second press without exiting', async () => {
    const controller = { interrupt: vi.fn(async () => {}), quit: vi.fn(async () => {}) };
    const notice = vi.fn();
    const interrupt = createTuiInterrupt(controller, { onNotice: notice, now: () => 0 });
    await interrupt();
    expect(controller.interrupt).toHaveBeenCalledExactlyOnceWith();
    expect(controller.quit).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledExactlyOnceWith('Press Ctrl+C again to exit.');
  });

  it('exits through controller cleanup on the second press and deduplicates further presses', async () => {
    const controller = { interrupt: vi.fn(async () => {}), quit: vi.fn(async () => {}) };
    let clock = 100;
    const interrupt = createTuiInterrupt(controller, { now: () => clock });
    await interrupt();
    clock = 1_100;
    const quitting = interrupt();
    expect(interrupt()).toBe(quitting);
    await quitting;
    await interrupt();
    expect(controller.interrupt).toHaveBeenCalledTimes(1);
    expect(controller.quit).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('accepts a second press while the first interrupt is still waiting', async () => {
    let release!: () => void;
    const pendingInterrupt = new Promise<void>(resolve => { release = resolve; });
    const controller = { interrupt: vi.fn(() => pendingInterrupt), quit: vi.fn(async () => {}) };
    const interrupt = createTuiInterrupt(controller, { now: () => 100 });
    const first = interrupt();
    await interrupt();
    expect(controller.quit).toHaveBeenCalledExactlyOnceWith(true);
    expect(controller.interrupt).toHaveBeenCalledTimes(1);
    release(); await first;
  });

  it('requires a fresh double press after the repeat window elapses', async () => {
    const controller = { interrupt: vi.fn(async () => {}), quit: vi.fn(async () => {}) };
    let clock = 0;
    const interrupt = createTuiInterrupt(controller, { now: () => clock });
    await interrupt();
    clock = 1_501;
    await interrupt();
    expect(controller.quit).not.toHaveBeenCalled();
    expect(controller.interrupt).toHaveBeenCalledTimes(2);
    clock += 1_500;
    await interrupt();
    expect(controller.quit).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('allows exiting after the first interrupt fails', async () => {
    const controller = { interrupt: vi.fn(async () => { throw new Error('interrupt failed'); }), quit: vi.fn(async () => {}) };
    const interrupt = createTuiInterrupt(controller, { now: () => 100 });
    await expect(interrupt()).rejects.toThrow('interrupt failed');
    await interrupt();
    expect(controller.quit).toHaveBeenCalledExactlyOnceWith(true);
  });

  it('allows another double press after cleanup fails without hiding the error', async () => {
    const controller = { interrupt: vi.fn(async () => {}), quit: vi.fn(async () => {}).mockRejectedValueOnce(new Error('cleanup pending')) };
    const interrupt = createTuiInterrupt(controller, { now: () => 100 });
    await interrupt();
    await expect(interrupt()).rejects.toThrow('cleanup pending');
    await interrupt();
    expect(controller.quit).toHaveBeenCalledTimes(1);
    await interrupt();
    expect(controller.quit).toHaveBeenCalledTimes(2);
    expect(controller.interrupt).toHaveBeenCalledTimes(2);
  });
});
