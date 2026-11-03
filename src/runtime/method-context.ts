import type { Store } from '../storage/index.js';
import type { Message, Run } from './types.js';
import type { HistorySnapshot } from './context.js';
import { historyRuns } from './history.js';
import { activeMethod } from '../extensions/methods.js';
import { historyReadPointer } from './view-pointers.js';

export interface MethodUnloading { archivedRef: string; offsets: number[]; instances: string[] }

function methodResults(messages: Message[]): Set<Message> {
  const result = new Set<Message>();
  let loads = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') loads = new Set(message.tool_calls?.filter(call => call.name === 'skill.load' || call.name === 'task').map(call => call.id));
    if (message.role === 'tool' && loads.has(message.tool_call_id)) result.add(message);
  }
  return result;
}

function instance(message: Message): string | undefined {
  if (message.role !== 'tool') return;
  try {
    const value = JSON.parse(message.content) as { methodInstance?: unknown; methodUnloaded?: boolean };
    return !value.methodUnloaded && typeof value.methodInstance === 'string' ? value.methodInstance : undefined;
  } catch { return; }
}

/** Keep the current method's paired tool rounds through ordinary compaction. */
export function activeMethodMessages(store: Store, run: Run, messages: Message[]): Set<Message> {
  if (!store.session(run.sessionId).inlineMethods) return new Set();
  const active = activeMethod(store, run.id);
  return new Set(active ? [...methodResults(messages)].filter(message => instance(message) === active.callId) : []);
}

/** Only explicit ended method instances are removable; reference Skills and evidence stay intact. */
export function unloadMethods(store: Store, run: Run, messages: Message[]): { messages: Message[]; unloaded: MethodUnloading } | undefined {
  const session = store.session(run.sessionId);
  if (!session.inlineMethods || !session.methodUnloading || run.parentId) return;
  const ended = new Set(historyRuns(store, run).flatMap(owner => store.events(owner.id, { types: ['method.ended'] })).map(event => event.data.callId as string));
  const active = activeMethod(store, run.id);
  if (active) ended.delete(active.callId);
  const eligible = methodResults(messages);
  const offsets = messages.flatMap((message, offset) => {
    const id = instance(message);
    return eligible.has(message) && id && ended.has(id) ? [offset] : [];
  });
  if (!offsets.length) return;
  const snapshot: HistorySnapshot = { version: 1, runId: run.id, sessionId: run.sessionId, messages, ...(run.scope ? { scope: run.scope } : {}) };
  const archivedRef = store.blob(snapshot);
  const removed = new Set(offsets);
  return {
    messages: messages.map((message, offset) => removed.has(offset) ? { ...message, content: JSON.stringify({
      ...retainedEvidence(message),
      methodUnloaded: true, methodInstance: instance(message),
      read: historyReadPointer(session.toolProfile, { ref: archivedRef, offset, limit: 1 }),
      note: 'Inactive method instructions removed at a context checkpoint. Work evidence is retained. Reading this archive does not activate the method; use skill.load to activate it again.',
    }) } : message),
    unloaded: { archivedRef, offsets, instances: [...new Set(offsets.map(offset => instance(messages[offset]!)!))] },
  };
}

/** Commit alongside the caller's context reference, never while merely preparing a projection. */
export function recordMethodUnloading(store: Store, runId: string, unloaded: MethodUnloading | undefined): void {
  if (unloaded) store.event(runId, 'context.methods.unloaded', { ...unloaded });
}

/** Stage inputs and project observations remain evidence after its instructions expire. */
function retainedEvidence(message: Message): Record<string, unknown> {
  const value = JSON.parse(message.content!) as Record<string, unknown>;
  return Object.fromEntries(['inputs', 'knowledge', 'method'].filter(key => key in value).map(key => [key, value[key]]));
}
