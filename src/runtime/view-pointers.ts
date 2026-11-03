/**
 * Read pointers embedded in model-visible text, rendered for the session's frozen
 * tool view. Lean views expose one `read` tool instead of `history.read`,
 * `history.search` and `artifact.read`; every other profile keeps the original
 * kernel pointers byte for byte.
 */

/** Arguments of a kernel `history.read` pointer; extra keys keep their given order. */
export interface HistoryReadArgs { ref: string; offset?: number; limit?: number; contentOffset?: number; maxChars?: number }
/** Pointer shape for old profiles: the kernel tool and its arguments unchanged. */
export interface KernelHistoryPointer<A extends HistoryReadArgs = HistoryReadArgs> { tool: 'history.read'; args: A }
/** Pointer shape for lean profiles: the `read` tool with a `history` reference. */
export interface LeanHistoryPointer { tool: 'read'; args: { history: string; offset?: number; limit?: number; contentOffset?: number; maxChars?: number } }
export type HistoryPointer<A extends HistoryReadArgs = HistoryReadArgs> = KernelHistoryPointer<A> | LeanHistoryPointer;

/** True when the frozen profile shows the lean tool view (`read` instead of history/artifact tools). */
export const leanProfile = (profile: string | undefined): boolean => profile === 'lean-solo';

/**
 * Render a history read pointer for the profile. Old profiles get the given args
 * object itself; lean profiles get `{ history, offset, ...rest }` in the given order.
 */
export function historyReadPointer<A extends HistoryReadArgs>(profile: string | undefined, args: A): HistoryPointer<A> {
  if (!leanProfile(profile)) return { tool: 'history.read', args };
  const { ref, offset, ...rest } = args;
  return { tool: 'read', args: { history: ref, ...(offset === undefined ? {} : { offset }), ...rest } };
}

/**
 * Accept either rendered pointer shape and return its exact archive position.
 * Returns undefined for anything that is not a well-formed history pointer.
 */
export function parseHistoryPointer(read: unknown): { ref: string; offset: number } | undefined {
  if (!read || typeof read !== 'object') return;
  const { tool, args } = read as { tool?: unknown; args?: { ref?: unknown; history?: unknown; offset?: unknown } };
  if (!args || typeof args !== 'object') return;
  const ref = tool === 'history.read' ? args.ref : tool === 'read' ? args.history : undefined;
  if (typeof ref !== 'string' || typeof args.offset !== 'number' || !Number.isSafeInteger(args.offset) || args.offset < 0) return;
  return { ref, offset: args.offset };
}

/** Model-visible name for searching history in prose. */
export function historySearchName(profile: string | undefined): string {
  return leanProfile(profile) ? 'read with history_query' : 'history.search';
}

/** Model-visible call text for paging history in prose, e.g. `history.read({...})`. */
export function historyReadCall(profile: string | undefined, ref: string, offset: number): string {
  return leanProfile(profile) ? `read(${JSON.stringify({ history: ref, offset })})` : `history.read(${JSON.stringify({ ref, offset })})`;
}
