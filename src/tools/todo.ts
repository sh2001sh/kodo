import { Ajv } from 'ajv';
import { digest } from '../storage/index.js';
import type { Store } from '../storage/index.js';
import { KodoError, terminal } from '../runtime/types.js';
import type { ToolRegistration } from './registry.js';

/**
 * A run-owned plan: an ordered checklist with revisions. It carries no executor,
 * dependency or dispatch semantics; it guides the run and never proves completion.
 */
export interface TodoItem { id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; title?: string; note?: string }
export interface TodoSnapshot { ownerRunId: string; revision: number; items: TodoItem[] }

const eventType = 'todo.updated';
const id = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' };
const ids = { type: 'array', uniqueItems: true, maxItems: 100, items: id };
const fields = {
  id, content: { type: 'string', minLength: 1, maxLength: 1000 },
  status: { enum: ['pending', 'in_progress', 'completed'] },
  title: { type: 'string', maxLength: 160 }, note: { type: 'string', maxLength: 1000 },
};
const readParameters = { type: 'object', additionalProperties: false, properties: { ids, full: { type: 'boolean' }, offset: { type: 'integer', minimum: 0, maximum: 100 }, limit: { type: 'integer', minimum: 1, maximum: 25 } } };
const writeParameters = {
  type: 'object', additionalProperties: false, required: ['expectedRevision'],
  properties: {
    expectedRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 },
    items: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['id', 'content', 'status'], properties: fields } },
    updates: { type: 'array', maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['id'], properties: fields } },
    remove: ids,
  },
  oneOf: [{ required: ['items'], not: { anyOf: [{ required: ['updates'] }, { required: ['remove'] }] } }, { required: ['updates'], not: { required: ['items'] } }, { required: ['remove'], not: { anyOf: [{ required: ['items'] }, { required: ['updates'] }] } }],
};
const ajv = new Ajv({ allErrors: true, strictRequired: false });
const validateRead = ajv.compile(readParameters);
const validateWrite = ajv.compile(writeParameters);

export function readTodoSnapshot(store: Store, runId: string): TodoSnapshot {
  const latest = store.latestEvent(runId, { types: [eventType] });
  if (!latest) return { ownerRunId: runId, revision: 0, items: [] };
  const snapshot = (latest.data as unknown as { snapshot: TodoSnapshot }).snapshot;
  return { ownerRunId: snapshot.ownerRunId, revision: snapshot.revision, items: snapshot.items };
}

/** Continue the same audited task plan after recovery changes its run identity. */
export function carryRecoveryTodo(store: Store, sourceId: string, targetId: string): void {
  const source = store.run(sourceId);
  const target = store.run(targetId);
  if (source.sessionId !== target.sessionId || target.continuationOf !== sourceId || target.historyFrom === sourceId || !store.hasEvent(sourceId, { types: ['recovery.continued'], match: { runId: targetId } })) throw new KodoError('TODO_OWNER', 'task plans transfer only across an audited same-session recovery');
  if (store.latestEvent(targetId, { types: [eventType] })) return;
  const snapshot = readTodoSnapshot(store, sourceId);
  if (!snapshot.revision) return;
  store.event(targetId, eventType, { snapshot: { ...structuredClone(snapshot), ownerRunId: targetId }, recoverySourceRunId: sourceId });
}

function readTodo(store: Store, runId: string, args: Record<string, unknown>): unknown {
  const snapshot = readTodoSnapshot(store, runId);
  if (!snapshot.revision && !Object.keys(args).length) return snapshot;
  const changed = new Set((store.latestEvent(runId, { types: [eventType] })?.data.changedIds as string[] | undefined) ?? []);
  const requested = args.ids as string[] | undefined;
  if (requested?.some(id => !snapshot.items.some(item => item.id === id))) throw new KodoError('TODO_ITEMS', 'requested task does not exist');
  const relevant = snapshot.items.filter(item => requested ? requested.includes(item.id) : args.full || item.status !== 'completed' || changed.has(item.id));
  const offset = args.offset as number ?? 0, limit = args.limit as number ?? 10;
  const items = relevant.slice(offset, offset + limit);
  return {
    ownerRunId: runId, revision: snapshot.revision, items,
    total: snapshot.items.length, matching: relevant.length,
    next: offset + items.length < relevant.length ? { ...args, offset: offset + items.length, limit } : null,
  };
}

function candidateItems(previous: TodoSnapshot, args: Record<string, unknown>): TodoItem[] {
  const updates = args.updates as (Partial<TodoItem> & { id: string })[] | undefined;
  const removed = new Set(args.remove as string[] ?? []);
  if (updates && new Set(updates.map(item => item.id)).size !== updates.length) throw new KodoError('TODO_ITEMS', 'update IDs must be unique');
  if ([...removed].some(id => !previous.items.some(item => item.id === id))) throw new KodoError('TODO_ITEMS', 'cannot remove a missing task');
  if (updates?.some(item => removed.has(item.id))) throw new KodoError('TODO_ITEMS', 'cannot update and remove the same task');
  const byId = new Map(previous.items.filter(item => !removed.has(item.id)).map(item => [item.id, structuredClone(item)]));
  for (const update of updates ?? []) {
    const item = { ...byId.get(update.id), ...update };
    if (!item.content || !item.status) throw new KodoError('TODO_ITEMS', `new task ${item.id} requires content and status`);
    byId.set(item.id, item as TodoItem);
  }
  const items = structuredClone((args.items as TodoItem[] | undefined) ?? [...byId.values()]);
  if (items.length > 100 || new Set(items.map(item => item.id)).size !== items.length) throw new KodoError('TODO_ITEMS', 'plan requires at most 100 unique task IDs');
  if (items.some(item => !item.content.trim() || [item.content, item.title, item.note].some(text => text?.includes('\0')))) throw new KodoError('TODO_ITEMS', 'task text must contain visible content and no NUL');
  return items;
}

function updateResult(snapshot: TodoSnapshot, changedIds: string[], removedIds: string[]) {
  const selected = [...snapshot.items.filter(item => changedIds.includes(item.id)), ...snapshot.items.filter(item => !changedIds.includes(item.id) && item.status !== 'completed')].slice(0, 10);
  return {
    ownerRunId: snapshot.ownerRunId, revision: snapshot.revision,
    items: selected.map(item => ({ ...item, content: item.content.slice(0, 400), ...(item.note !== undefined ? { note: item.note.slice(0, 200) } : {}),
      ...(item.content.length > 400 || (item.note?.length ?? 0) > 200 ? { detailsTruncated: true } : {}),
    })),
    total: snapshot.items.length, omitted: snapshot.items.length - selected.length, changedIds, removedIds,
    read: { full: true, limit: 10 },
  };
}

/** Run-owned plans are internal durable state, never workspace files or cross-agent writes. */
export function todoTools(store: Store): ToolRegistration[] {
  return [
    {
      name: 'todo.read', version: '3', permission: 'read', effect: 'read', parameters: readParameters,
      description: 'Read a bounded view of this run’s tasks and current revision. Defaults to unfinished or recently changed tasks. Use ids for selected tasks, or full:true with offset/limit for the complete plan. Task content defines the work; title/note are display only. Persisted plans survive restart.',
      execute({ run, session, signal }, args) {
        signal.throwIfAborted();
        if (store.run(run.id).sessionId !== session.id) throw new KodoError('TODO_OWNER', 'task list belongs to a different session');
        if (!validateRead(args)) throw new KodoError('TOOL_ARGUMENTS', `arguments do not match the todo.read schema: ${ajv.errorsText(validateRead.errors)}`);
        return readTodo(store, run.id, args);
      },
    },
    {
      name: 'todo.write', version: '3', permission: 'read', effect: 'read', parameters: writeParameters,
      description: 'Atomically update tasks by stable ID with expectedRevision (0 initially). Prefer updates:[{id,status,note}] for progress; new IDs require content and status. title/note never change task identity. remove deletes IDs in the same transaction. items is an alternative full replacement, not a patch. Returned items are bounded summaries; use todo.read by ID for full definitions. This plan guides work; it does not dispatch children or prove overall correctness.',
      execute({ run, session, signal, markEffectStarted }, args) {
        signal.throwIfAborted();
        if (!validateWrite(args)) throw new KodoError('TOOL_ARGUMENTS', `arguments do not match the todo.write schema: ${ajv.errorsText(validateWrite.errors)}`);
        return store.transaction(() => {
          const current = store.run(run.id);
          if (current.sessionId !== session.id) throw new KodoError('TODO_OWNER', 'task list belongs to a different session');
          if (terminal(current.status)) throw new KodoError('TODO_TERMINAL', 'a finished run cannot change its task list');
          const previous = readTodoSnapshot(store, run.id);
          if (args.expectedRevision !== previous.revision) throw new KodoError('TODO_CONFLICT', 'task revision changed; read the current list before updating');
          const items = candidateItems(previous, args);
          const snapshot: TodoSnapshot = { ownerRunId: run.id, revision: previous.revision + 1, items };
          signal.throwIfAborted();
          markEffectStarted();
          const changedIds = items.filter(item => JSON.stringify(item) !== JSON.stringify(previous.items.find(old => old.id === item.id))).map(item => item.id);
          const removedIds = previous.items.filter(old => !items.some(item => item.id === old.id)).map(item => item.id);
          const result = updateResult(snapshot, changedIds, removedIds);
          store.event(run.id, eventType, { snapshot, result, argsDigest: digest(JSON.stringify(args)), changedIds });
          return result;
        });
      },
      recover({ run, request, signal }) {
        signal.throwIfAborted();
        const hash = digest(JSON.stringify(JSON.parse(request.arguments) as unknown));
        const committed = store.latestEvent(run.id, { types: [eventType], match: { argsDigest: hash } });
        return committed ? { outcome: 'succeeded', evidence: 'The run-owned task update committed in the durable event store.', result: committed.data.result ?? (committed.data as unknown as { snapshot: TodoSnapshot }).snapshot }
          : { outcome: 'not_applied', evidence: 'No matching task update committed; the transaction left no partial state.' };
      },
    },
  ];
}
