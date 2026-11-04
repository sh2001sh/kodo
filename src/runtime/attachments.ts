import type { Message } from './types.js';

/**
 * Registry of kernel-generated context blocks. `kodo-context` blocks are
 * host-assembled task context (frozen prefix layers and their deltas);
 * `kodo-runtime` blocks are kernel notices and the per-request state frame.
 * Every block is a user-role message: system messages appear only at the start.
 */
export const attachmentKinds = {
  agents: { tag: 'kodo-context', maxChars: Number.MAX_SAFE_INTEGER, persist: true, order: 5, trigger: 'initial frozen session roster' },
  'project-instructions': { tag: 'kodo-context', maxChars: 80_000, persist: true, order: 10, trigger: 'initial, touch, before-write, changed' },
  environment: { tag: 'kodo-context', maxChars: 80_000, persist: true, order: 20, trigger: 'initial or environment changed' },
  state: { tag: 'kodo-runtime', maxChars: 8_000, persist: false, order: 100, trigger: 'every model request, always last' },
  notice: { tag: 'kodo-runtime', maxChars: 8_000, persist: true, order: 70, trigger: 'runtime feedback' },
  nudge: { tag: 'kodo-runtime', maxChars: 4_000, persist: true, order: 80, trigger: 'explicit host opt-in and threshold reached' },
  'changed-files': { tag: 'kodo-runtime', maxChars: 8_000, persist: true, order: 60, trigger: 'observed file changed' },
  'task-notification': { tag: 'kodo-runtime', maxChars: 8_000, persist: true, order: 40, trigger: 'child or background task settled' },
  mailbox: { tag: 'kodo-runtime', maxChars: 16_000, persist: true, order: 30, trigger: 'peer message delivered' },
  compaction: { tag: 'kodo-runtime', maxChars: 16_000, persist: true, order: 50, trigger: 'summary installed or history folded' },
  memory: { tag: 'kodo-runtime', maxChars: 8_000, persist: true, order: 25, trigger: 'recorded memory changed' },
  'completion-check': { tag: 'kodo-runtime', maxChars: 16_000, persist: true, order: 90, trigger: 'host completion check' },
  'delivery-audit': { tag: 'kodo-runtime', maxChars: 16_000, persist: true, order: 90, trigger: 'delivery audit' },
} as const;
export type AttachmentKind = keyof typeof attachmentKinds;

/** Text inside a block cannot open or close another kernel block. */
export function escapeMarkers(text: string): string {
  return text.replace(/<(\/?)kodo-/gi, '&lt;$1kodo-');
}

/** Render one bounded, escaped block. Over-budget bodies are cut with a visible note, never silently. */
export function attachment(kind: AttachmentKind, body: string, attributes: Record<string, string> = {}): Message {
  const { tag, maxChars } = attachmentKinds[kind];
  let text = escapeMarkers(body);
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n[kernel truncated this block: ${maxChars} of ${text.length} characters shown]`;
  const extra = Object.entries(attributes).map(([key, value]) => ` ${key}="${escapeMarkers(value).replaceAll('"', '&quot;')}"`).join('');
  return { role: 'user', content: `<${tag} kind="${kind}"${extra}>\n${text}\n</${tag}>` };
}

/** Kind of a kernel block, or undefined for any other message. */
export function attachmentKind(message: Message): AttachmentKind | undefined {
  if (message.role !== 'user') return;
  const match = /^<(kodo-context|kodo-runtime) kind="([a-z-]+)"[^>\n]*>\n/.exec(message.content);
  if (!match) return;
  const kind = match[2] as AttachmentKind;
  return Object.hasOwn(attachmentKinds, kind) && attachmentKinds[kind].tag === match[1] && message.content.endsWith(`\n</${match[1]}>`) ? kind : undefined;
}

/** Body of a kernel block without its tags; escaping stays applied. */
export function attachmentBody(message: Message): string {
  const content = message.role === 'user' ? message.content : '';
  return content.slice(content.indexOf('>\n') + 2, content.lastIndexOf('\n</'));
}

/** Sort one newly generated attachment group; never reorder persisted history or tool/result pairs. */
export function orderAttachments(messages: readonly Message[]): Message[] {
  return [...messages].sort((left, right) => {
    const a = attachmentKind(left);
    const b = attachmentKind(right);
    return (a ? attachmentKinds[a].order : 70) - (b ? attachmentKinds[b].order : 70);
  });
}

