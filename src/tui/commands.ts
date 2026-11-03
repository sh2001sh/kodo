import { KodoError } from '../runtime/types.js';
import type { RunStatus } from '../runtime/types.js';
import type { TuiItem, TuiPanel } from './types.js';

export const mainCommands = [
  ['help', 'Help and shortcuts', 'view'], ['new', 'New session', 'action'], ['resume', 'Session history', 'view'],
  ['model', 'Select provider and model', 'view'], ['agents', 'Agent library', 'view'], ['tasks', 'Tasks and agents', 'view'],
  ['changes', 'Changes and deliverables', 'view'], ['check', 'Project verification', 'view'], ['context', 'Context and usage', 'view'],
  ['settings', 'Connection and execution', 'view'], ['stop', 'Interrupt current turn', 'action'], ['quit', 'Save and exit', 'action'],
] as const;

/** Search-only actions preserve the twelve primary entries in the initial menu. */
export const auxiliaryCommands: TuiItem[] = [
  { id: 'providers', label: '/providers  Providers and groups', detail: 'Select a connection or merge provider catalogues', command: '/providers' },
  { id: 'permissions', label: '/permissions  Ask or YOLO mode', detail: 'Review and configure tool approvals', command: '/permissions' },
  { id: 'status', label: '/status  Session overview', detail: 'Local view', command: '/status' },
  { id: 'decision', label: '/decision  Update task constraints', detail: 'Action; add the new constraints before sending', input: '/decision ' },
  { id: 'next', label: '/next  Follow-up queue', detail: 'View, edit or remove queued tasks', command: '/next' },
  { id: 'cancel', label: '/cancel  Cancel current task', detail: 'Action; existing files and records are retained', command: '/cancel' },
  { id: 'paste', label: '/paste  Start literal multiline input', detail: 'Action; pasted text is not executed as a command', command: '/paste' },
  { id: 'send', label: '/send  Submit multiline input', detail: 'Action; send the text collected by /paste', command: '/send' },
  { id: 'keys', label: '/help keys  Keyboard shortcuts', detail: 'Local view', command: '/help keys' },
];

/** Tokenize command arguments, never evaluate shell syntax or expand environment variables. */
export function parseCommand(text: string): string[] {
  const tokens: string[] = [];
  let word = '', quote = '', started = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (character === '\\' && quote && text[index + 1] === quote) { word += text[++index]; continue; }
    if (quote) { if (character === quote) quote = ''; else word += character; started = true; continue; }
    if (character === '"' || character === "'") { quote = character; started = true; continue; }
    if (/\s/u.test(character)) { if (started) { tokens.push(word); word = ''; started = false; } }
    else { word += character; started = true; }
  }
  if (quote) throw new KodoError('TUI_COMMAND', 'Unclosed quote; enclose paths containing spaces in matching quotes.');
  if (started) tokens.push(word);
  return tokens;
}

export const statusLabel: Record<RunStatus, string> = {
  queued: 'Queued', running: 'Running', waiting: 'Waiting', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted',
};
// Keep literal backslashes outside quotes, including a trailing backslash before the closing quote.
export const quoteArgument = (value: string): string => value.split('\\').map(part => `"${part.replaceAll('"', '\\"')}"`).join('\\');

export function helpPanel(keys = false): TuiPanel {
  if (keys) return { title: 'Keyboard shortcuts', lines: [
    'Enter: send or select. Shift+Enter: newline when supported.', 'Type / for commands or @ for files. Tab: accept a suggestion.',
    'Up/Down: select a suggestion. Ctrl+P: command palette.', 'Ctrl+O: expand tool activity. Ctrl+G: external editor.',
    'Shift+Tab: permissions. /permissions: choose Ask or YOLO.',
    'Esc: dismiss suggestions or panels; interrupt an active turn when the draft is empty.',
    'Ctrl+C: interrupt; press twice to exit. Unsent text is retained until exit.',
    'PageUp/PageDown: scroll history. /paste and /send: multiline input fallback.',
    'Some terminals reserve shortcuts; the corresponding slash commands remain available.',
  ] };
  return { title: 'Commands', lines: [],
    items: mainCommands.map(([name, label, kind]) => ({ id: name, label: `/${name}  ${label}`, detail: name === 'model' ? 'Fetch model IDs; select for new sessions' : kind === 'view' ? 'Local view' : 'Action', command: `/${name}` })),
    hint: 'Type to filter. Enter to select. Esc to return.',
  };
}
