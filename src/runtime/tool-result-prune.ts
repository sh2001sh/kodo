import type { Call, Message } from './types.js';
import { historyReadPointer } from './view-pointers.js';

type ToolMessage = Extract<Message, { role: 'tool' }>;

/** Old tool results above this size keep only a head and a tail in model input. */
export const pruneThresholdChars = 8192;
const pruneHeadChars = 4096;
const pruneTailChars = 1024;
export const prunedMarker = '[... tool result middle pruned ...]';
const maskThresholdChars = 768;
const maskPreviewChars = 240;
const metadataKeys = ['path', 'hash', 'offset', 'contentOffset', 'next', 'truncated', 'exitCode'];

/** Locates one recorded observation in the immutable archive snapshot. */
export interface ToolResultSource {
  archivedRef: string;
  offsetOf(message: Message): number;
  call(message: ToolMessage): Call | undefined;
}

export function excerpt(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const head = Math.ceil(maxChars * 0.7);
  return `${content.slice(0, head)}\n[... archived middle omitted ...]\n${content.slice(-(maxChars - head))}`;
}

function toolName(source: ToolResultSource, group: Message[], message: ToolMessage): string | undefined {
  const call = source.call(message);
  if (call) return call.name;
  const first = group[0];
  return first?.role === 'assistant' ? first.tool_calls?.find(item => item.id === message.tool_call_id)?.name : undefined;
}

/**
 * Deterministic first compaction stage: an oversized old result keeps its head
 * and tail with an exact archive pointer to the full text. Returns undefined
 * when the message is small enough or carries images.
 */
export function pruneToolMessage(message: Message, source: ToolResultSource): ToolMessage | undefined {
  if (message.role !== 'tool' || message.images?.length || message.content.length <= pruneThresholdChars) return undefined;
  const read = JSON.stringify(historyReadPointer({ ref: source.archivedRef, offset: source.offsetOf(message), limit: 1 }));
  const content = `${message.content.slice(0, pruneHeadChars)}\n${prunedMarker} ${message.content.length - pruneHeadChars - pruneTailChars} characters omitted from model input, not deleted; full result: ${read}\n${message.content.slice(-pruneTailChars)}`;
  return { role: 'tool', tool_call_id: message.tool_call_id, content };
}

/**
 * Second stage: replace an old observation with metadata, a short preview and
 * the archive pointer. Existing masks are never wrapped again.
 */
export function maskToolMessage(message: Message, group: Message[], source: ToolResultSource): ToolMessage | undefined {
  if (message.role !== 'tool' || message.content.length < maskThresholdChars) return undefined;
  try { if ((JSON.parse(message.content) as { contextHidden?: boolean }).contextHidden) return undefined; } catch { /* Plain-text observations are allowed. */ }
  const call = source.call(message);
  let metadata: Record<string, unknown> = {};
  let body = message.content;
  try {
    const value = JSON.parse(message.content) as Record<string, unknown>;
    metadata = Object.fromEntries(metadataKeys.filter(key => key in value).map(key => [key, value[key]]));
    const text = ['content', 'stdout', 'text', 'output'].map(key => value?.[key]).find(item => typeof item === 'string');
    if (typeof text === 'string') body = text;
  } catch { /* Full text remains in the archive. */ }
  // A short head/tail preview keeps the observation recognizable without rereading it.
  metadata.preview = excerpt(body.replace(/\s+/g, ' ').trim(), maskPreviewChars);
  const content = JSON.stringify({ contextHidden: true, tool: toolName(source, group, message), callId: call?.id ?? message.tool_call_id, status: call?.status ?? 'recorded', ...metadata, originalChars: message.content.length, coverage: 'recorded-message', read: historyReadPointer({ ref: source.archivedRef, offset: source.offsetOf(message), limit: 1 }), note: 'Older observation hidden from model input, not deleted. Read original evidence instead of repeating the operation.' });
  return content.length < message.content.length ? { role: 'tool', tool_call_id: message.tool_call_id, content } : undefined;
}
