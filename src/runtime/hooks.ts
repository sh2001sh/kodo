import type { Store } from '../storage/index.js';
import { errorText, KodoError } from './types.js';

export const hookKinds = ['tool.before', 'tool.after', 'tool.failed', 'run.stop', 'subagent.stop', 'compaction.before', 'compaction.after', 'session.start', 'session.end'] as const;
export type HookKind = typeof hookKinds[number];
export interface HookInput { kind: HookKind; runId: string; data: Readonly<Record<string, unknown>> }
/** A hook can supply context, or veto a permitted boundary; it cannot replace the operation. */
export interface HookResult { note?: string; deny?: string }
export interface HookRegistration {
  kind: HookKind;
  id?: string;
  callback: (input: Readonly<HookInput>, signal: AbortSignal) => HookResult | void | Promise<HookResult | void>;
}
export interface HookOutcome { denied: boolean; notes: string[] }
const vetoes = new Set<HookKind>(['tool.before', 'run.stop', 'subagent.stop']);
const maxNoteChars = 8000;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateResult(kind: HookKind, value: unknown): HookResult {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'note' && key !== 'deny')) throw new KodoError('HOOK_RESULT', 'hooks may return only note and deny fields');
  const result = value as HookResult;
  for (const text of [result.note, result.deny]) if (text !== undefined && (typeof text !== 'string' || !text.trim() || text.length > maxNoteChars)) throw new KodoError('HOOK_RESULT', `hook text must contain 1-${maxNoteChars} characters`);
  if (result.deny !== undefined && !vetoes.has(kind)) throw new KodoError('HOOK_RESULT', `${kind} hooks can add context but cannot veto an operation already performed`);
  return { ...(result.note ? { note: result.note } : {}), ...(result.deny ? { deny: result.deny } : {}) };
}

/** Bounded host callbacks. Results contain no mutable runtime objects or replacement inputs. */
export class HostHooks {
  private readonly registrations: readonly HookRegistration[];
  private readonly timeoutMs: number;
  constructor(private readonly store: Store, registrations: readonly HookRegistration[] = [], options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 10_000) throw new KodoError('HOOK_CONFIG', 'hook timeout must be between 1 and 10000 ms');
    const ids = new Set<string>();
    this.registrations = registrations.map((registration, index) => {
      if (!hookKinds.includes(registration.kind) || typeof registration.callback !== 'function') throw new KodoError('HOOK_CONFIG', 'hook registration requires a supported kind and callback');
      const id = registration.id ?? `${registration.kind}:${index}`;
      if (!id || id.length > 200 || ids.has(id)) throw new KodoError('HOOK_CONFIG', 'hook identifiers must be unique and contain 1-200 characters');
      ids.add(id);
      return Object.freeze({ kind: registration.kind, id, callback: registration.callback });
    });
  }

  async run(kind: HookKind, input: { runId: string; data?: Record<string, unknown> }, signal?: AbortSignal): Promise<HookOutcome> {
    if (this.store.fault !== undefined) throw this.store.fault;
    const outcome: HookOutcome = { denied: false, notes: [] };
    for (const registration of this.registrations.filter(item => item.kind === kind)) {
      signal?.throwIfAborted();
      const event = freeze(structuredClone({ kind, runId: input.runId, data: input.data ?? {} }));
      const controller = new AbortController();
      const timedOut = new KodoError('HOOK_TIMEOUT', `hook exceeded ${this.timeoutMs} ms`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      let result: HookResult | undefined;
      let failure: unknown;
      let failed = false;
      try {
        const stopped = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { controller.abort(timedOut); reject(timedOut); }, this.timeoutMs);
          abort = (): void => { controller.abort(signal!.reason); reject(signal!.reason); };
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
        result = validateResult(kind, await Promise.race([Promise.resolve().then(() => registration.callback(event, controller.signal)), stopped]));
      } catch (error) { failure = error; failed = true; }
      finally {
        clearTimeout(timer);
        if (abort) signal?.removeEventListener('abort', abort);
      }
      signal?.throwIfAborted();
      if (this.store.fault !== undefined) throw this.store.fault;
      if (failed) {
        this.store.event(input.runId, failure === timedOut ? 'hook.timed_out' : 'hook.failed', { kind, hookId: registration.id, error: errorText(failure), answered: false });
        continue;
      }
      if (result?.note) outcome.notes.push(result.note);
      if (result?.deny) { outcome.denied = true; outcome.notes.push(result.deny); }
      this.store.event(input.runId, 'hook.finished', { kind, hookId: registration.id, answered: true, denied: Boolean(result?.deny), ...(result?.note ? { note: result.note } : {}), ...(result?.deny ? { reason: result.deny } : {}) });
    }
    return outcome;
  }
}
