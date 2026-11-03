/** Read pointers embedded in model-visible text. */

/** Arguments of a kernel `history.read` pointer; extra keys keep their given order. */
export interface HistoryReadArgs { ref: string; offset?: number; limit?: number; contentOffset?: number; maxChars?: number }
export interface HistoryPointer<A extends HistoryReadArgs = HistoryReadArgs> { tool: 'history.read'; args: A }

/** A history read pointer: the kernel tool and its arguments unchanged. */
export function historyReadPointer<A extends HistoryReadArgs>(args: A): HistoryPointer<A> {
  return { tool: 'history.read', args };
}

/** Return a rendered pointer's exact archive position, or undefined when it is not a well-formed history pointer. */
export function parseHistoryPointer(read: unknown): { ref: string; offset: number } | undefined {
  if (!read || typeof read !== 'object') return;
  const { tool, args } = read as { tool?: unknown; args?: { ref?: unknown; offset?: unknown } };
  if (tool !== 'history.read' || !args || typeof args !== 'object') return;
  if (typeof args.ref !== 'string' || typeof args.offset !== 'number' || !Number.isSafeInteger(args.offset) || args.offset < 0) return;
  return { ref: args.ref, offset: args.offset };
}

/** Model-visible call text for paging history in prose, e.g. `history.read({...})`. */
export function historyReadCall(ref: string, offset: number): string {
  return `history.read(${JSON.stringify({ ref, offset })})`;
}
