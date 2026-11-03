import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { runTui } from '../src/tui/index.js';
import type { TuiActions, TuiSnapshot } from '../src/tui/types.js';

describe('TUI terminal lifecycle', () => {
  it.each([
    { originalRaw: false, second: 'raw' }, { originalRaw: true, second: 'raw' },
    { originalRaw: false, second: 'signal' }, { originalRaw: true, second: 'signal' },
  ])('exits on consecutive interrupts ($second), restores raw mode $originalRaw and removes owned listeners', async ({ originalRaw, second }) => {
    let quitting = false;
    const listeners = new Set<() => void>();
    const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: originalRaw, setRawMode(enabled: boolean) { this.isRaw = enabled; return this; } });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
    const stderr = new PassThrough();
    let output = '';
    stdout.on('data', chunk => { output += String(chunk); });
    const controller: TuiActions = {
      snapshot: (): TuiSnapshot => ({ workspace: 'fixture', model: 'fixture', status: 'idle', entries: [], tasks: [], questions: [], queue: [], usage: '', busy: false, quitting }),
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      submit: vi.fn(async () => {}), dismissPanel() {}, interrupt: vi.fn(async () => {}),
      quit: vi.fn(async () => { quitting = true; listeners.forEach(listener => listener()); }),
      onText() {}, close: vi.fn(async () => {}),
    };
    const signalListeners = { interrupt: process.listenerCount('SIGINT'), terminate: process.listenerCount('SIGTERM'), exit: process.listenerCount('exit') };
    const running = runTui(controller, { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, stderr: stderr as unknown as NodeJS.WriteStream });
    try {
      await vi.waitFor(() => expect(output).toContain('Kodo'));
      expect(stdin.isRaw).toBe(true);
      expect(output).toContain('\u001b[?2004h');
      stdin.write('unsent draft');
      await vi.waitFor(() => expect(output).toContain('unsent draft'));
      stdin.write('\u0003');
      await vi.waitFor(() => expect(controller.interrupt).toHaveBeenCalledTimes(1));
      expect(controller.quit).not.toHaveBeenCalled();
      expect(quitting).toBe(false);
      if (second === 'signal') process.emit('SIGINT');
      else stdin.write('\u0003');
      await running;
      expect(controller.quit).toHaveBeenCalledExactlyOnceWith(true);
      expect(stdin.isRaw).toBe(originalRaw);
      expect(output).toContain('\u001b[?2004l');
      expect(output).toContain('\u001b[?25h');
      expect(output).toContain('\u001b[?1049l');
      expect(listeners.size).toBe(0);
      expect(process.listenerCount('SIGINT')).toBe(signalListeners.interrupt);
      expect(process.listenerCount('SIGTERM')).toBe(signalListeners.terminate);
      expect(process.listenerCount('exit')).toBe(signalListeners.exit);
      expect(controller.close).not.toHaveBeenCalled();
    } finally {
      await controller.quit(true);
      await running;
      stdin.destroy(); stdout.destroy(); stderr.destroy();
    }
  });
});
