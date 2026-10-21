import { Store } from '../storage/index.js';
import { KodoError } from './types.js';
import type { Message, Run } from './types.js';
import type { HistorySnapshot } from './context.js';

/** Recovery transfers history only when the predecessor's durable audit explicitly identifies this run. */
export function recoveryHistoryRuns(store: Store, run: Run): Run[] {
  const lineage = [run];
  const visited = new Set([run.id]);
  let current = run;
  while (current.continuationOf && !visited.has(current.continuationOf)) {
    const source = store.run(current.continuationOf);
    if (source.sessionId !== run.sessionId || !store.events(source.id).some(event => event.type === 'recovery.continued' && event.data.runId === current.id)) break;
    lineage.push(source);
    visited.add(source.id);
    current = source;
  }
  return lineage;
}

/** Only references indexed by committed context events are readable; arbitrary blobs are never exposed. */
export function readHistory(store: Store, requesterId: string, options: { ref: string; offset?: number; limit?: number; contentOffset?: number; maxChars?: number }): {
  ref: string; runId: string; messages: Message[]; offset: number; nextOffset?: number; total: number; previousRef?: string;
  fragments: { messageIndex: number; start: number; end: number; totalChars: number; text: string }[];
  next?: { ref: string; offset: number; contentOffset: number };
} {
  const requester = store.run(requesterId);
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 20;
  const contentOffset = options.contentOffset ?? 0;
  const maxChars = options.maxChars ?? 16_000;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(contentOffset) || contentOffset < 0 || !Number.isSafeInteger(maxChars) || maxChars < 256 || maxChars > 32_000) throw new KodoError('HISTORY_ARGUMENTS', 'offset/contentOffset must be nonnegative, limit between 1 and 100, and maxChars between 256 and 32000');
  const inherited = recoveryHistoryRuns(store, requester);
  const mainIds = new Set(inherited.map(run => run.id));
  const managed = requester.parentId ? [] : store.listRuns().filter(run => run.sessionId === requester.sessionId && run.parentId && mainIds.has(run.parentId));
  const owners = [...inherited, ...managed.flatMap(run => recoveryHistoryRuns(store, run))];
  const owner = owners.find(run => store.events(run.id).some(event => event.type === 'context.compacted' && event.data.archivedRef === options.ref));
  if (!owner) throw new KodoError('HISTORY_DENIED', 'history reference is not indexed for this run or its managed children');
  const snapshot = store.readBlob<HistorySnapshot>(options.ref);
  if (snapshot.version !== 1 || snapshot.runId !== owner.id || snapshot.sessionId !== requester.sessionId || !Array.isArray(snapshot.messages)) throw new KodoError('HISTORY_DENIED', 'history snapshot ownership does not match the durable index');
  const messages: Message[] = [];
  const fragments: { messageIndex: number; start: number; end: number; totalChars: number; text: string }[] = [];
  let index = offset;
  let position = contentOffset;
  let remaining = maxChars;
  for (let count = 0; index < snapshot.messages.length && count < limit && remaining; count++) {
    const message = snapshot.messages[index]!;
    const serialized = JSON.stringify(message);
    if (position >= serialized.length) throw new KodoError('HISTORY_ARGUMENTS', 'contentOffset is outside the selected message');
    const end = Math.min(serialized.length, position + remaining);
    if (!position && end === serialized.length) messages.push(message);
    else fragments.push({ messageIndex: index, start: position, end, totalChars: serialized.length, text: serialized.slice(position, end) });
    remaining -= end - position;
    if (end < serialized.length) { position = end; break; }
    index++;
    position = 0;
  }
  return { ref: options.ref, runId: owner.id, messages, fragments, offset, ...(index < snapshot.messages.length ? { nextOffset: index, next: { ref: options.ref, offset: index, contentOffset: position } } : {}), total: snapshot.messages.length, ...(snapshot.previousRef ? { previousRef: snapshot.previousRef } : {}) };
}
