import { render } from 'ink';
import { errorText } from '../runtime/types.js';
import { terminalText } from '../cli/terminal.js';
import { KodoTui } from './view.js';
import { createTuiInterrupt } from './interrupt.js';
import type { TuiActions } from './types.js';

export interface TuiStreams { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream }

/** The CLI owns Application lifetime; this adapter owns terminal modes and listeners only. */
export async function runTui(controller: TuiActions, streams: TuiStreams = {}): Promise<void> {
  const stdin = streams.stdin ?? process.stdin;
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;
  const raw = stdin.isRaw;
  let showInterruptNotice: ((text: string) => void) | undefined;
  const handleInterrupt = createTuiInterrupt(controller, { onNotice: text => showInterruptNotice?.(text) });
  const interrupt = (onNotice?: (text: string) => void): Promise<void> => {
    if (onNotice) showInterruptNotice = onNotice;
    return handleInterrupt();
  };
  const report = (error: unknown) => { stderr.write(`${terminalText(errorText(error))}\n`); };
  const sigint = () => { void interrupt().catch(report); };
  const sigterm = () => { void controller.quit(true).catch(report); };
  const restore = () => {
    if (stdout.isTTY) stdout.write('\u001b[?2004l\u001b[?25h\u001b[?1049l');
    if (stdin.isTTY && stdin.isRaw !== raw) stdin.setRawMode(Boolean(raw));
  };
  process.on('SIGINT', sigint);
  process.on('SIGTERM', sigterm);
  process.once('exit', restore);
  let instance: ReturnType<typeof render> | undefined;
  try {
    instance = render(<KodoTui controller={controller} onInterrupt={interrupt} />, { stdin, stdout, stderr, exitOnCtrlC: false, patchConsole: false, maxFps: 25, alternateScreen: true, incrementalRendering: true });
    await instance.waitUntilExit();
  } finally {
    try { instance?.unmount(); }
    finally {
      process.off('SIGINT', sigint);
      process.off('SIGTERM', sigterm);
      process.off('exit', restore);
      restore();
    }
  }
}

export { KodoTui } from './view.js';
