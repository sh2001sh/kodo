import type { TuiActions } from './types.js';

export interface TuiInterruptOptions {
  onNotice?: (text: string) => void;
  now?: () => number;
  repeatMs?: number;
}

/** Share one gesture across raw Ctrl+C input and process SIGINT notifications. */
export function createTuiInterrupt(controller: Pick<TuiActions, 'interrupt' | 'quit'>, options: TuiInterruptOptions = {}): () => Promise<void> {
  const now = options.now ?? Date.now;
  const repeatMs = options.repeatMs ?? 1_500;
  let armedAt: number | undefined;
  let interrupting: Promise<void> | undefined;
  let quitting: Promise<void> | undefined;

  return () => {
    if (quitting) return quitting;
    const pressedAt = now();
    if (armedAt !== undefined && pressedAt >= armedAt && pressedAt - armedAt <= repeatMs) {
      armedAt = undefined;
      // An interrupt may be waiting for a model or tool to settle. The second
      // press must still start the controller's regular exit and cleanup path.
      const pending = Promise.resolve().then(() => controller.quit(true));
      quitting = pending;
      void pending.catch(() => { if (quitting === pending) quitting = undefined; });
      return pending;
    }

    armedAt = pressedAt;
    options.onNotice?.('Press Ctrl+C again to exit.');
    if (!interrupting) {
      const pending = Promise.resolve().then(() => controller.interrupt());
      interrupting = pending;
      const settled = () => { if (interrupting === pending) interrupting = undefined; };
      void pending.then(settled, settled);
    }
    return interrupting;
  };
}
