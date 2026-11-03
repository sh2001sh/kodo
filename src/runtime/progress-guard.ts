import type { Store } from '../storage/index.js';
import { collaborationTool } from '../messaging/index.js';
import { scriptRead, scriptReadRequest } from './script-read.js';
import type { Call } from './types.js';

/** Unchanged reads of one file range after which the run is told to act on its evidence. */
export const rereadLimit = 3;

const readKey = (store: Store, call: Call): string | undefined => {
  if (call.kind !== 'tool' || call.name !== 'file.read' || call.status !== 'succeeded' || !call.resultRef) return undefined;
  try {
    const args = JSON.parse(store.readBlob<{ arguments: string }>(call.requestRef).arguments) as Record<string, unknown>;
    const result = store.readBlob<{ hash?: unknown }>(call.resultRef);
    if (typeof args.path !== 'string' || typeof result.hash !== 'string') return undefined;
    return JSON.stringify([args.path, args.offset ?? 1, args.limit ?? null, args.contentOffset ?? 0, result.hash]);
  } catch { return undefined; }
};

/**
 * Detects re-reads of the same unchanged file range anywhere in the run, which
 * the consecutive stall check misses when a model alternates between ranges.
 * Returns the paths read at least `rereadLimit` times by the given new calls.
 */
export function repeatedReads(store: Store, runId: string, newCallIds: ReadonlySet<string>): string[] {
  const counts = new Map<string, number>();
  const flagged = new Set<string>();
  for (const call of store.calls(runId)) {
    const fileKey = readKey(store, call);
    const script = fileKey ? undefined : scriptRead(store, call);
    const key = fileKey ?? script?.key;
    if (!key) continue;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count >= rereadLimit && newCallIds.has(call.id)) flagged.add(fileKey ? JSON.parse(fileKey)[0] as string : script!.label);
  }
  return [...flagged];
}

/** Successful read/list/search calls a writable main run may make before its first action. */
export const writeNudgeReadCalls = 30;
/** Protocol 3 checks a recent exploration window rather than the run's entire history. */
export const investigationNudgeReadCalls = 8;
const investigationTools = new Set(['file.read', 'file.list', 'file.search']);

/**
 * One-time advisory for sustained investigation, including literal shell reads.
 * Protocol 3 uses a recent successful-read window and stops advising after actual
 * delegation; legacy protocols retain the before-first-action check. The caller
 * records `progress.write_nudged` so recovery does not repeat the advisory.
 */
export function writeNudge(store: Store, runId: string, writable: boolean): { text: string; readCalls: number } | undefined {
  const run = store.run(runId);
  if (run.parentId || !writable || store.hasEvent(runId, { types: ['progress.write_nudged'] })) return undefined;
  const recentWindow = store.session(run.sessionId).taskProtocol === 3;
  if (recentWindow && store.listRuns(run.sessionId).some(child => child.parentId === runId)) return undefined;
  let readCalls = 0;
  for (const call of store.calls(runId)) {
    if (call.kind !== 'tool') continue;
    // Inline read scripts (`node -e "fs.readFileSync(...)"`) are investigation, not an action.
    const scripted = scriptReadRequest(store, call) !== undefined;
    if (recentWindow) {
      // Failed reads, unknown commands, edits and management interrupt the window.
      // A command's request alone cannot prove it completed a useful read.
      const successfulRead = call.status === 'succeeded' && (scripted ? scriptRead(store, call) !== undefined : investigationTools.has(call.name));
      readCalls = successfulRead ? readCalls + 1 : 0;
      continue;
    }
    if (call.effect === 'write' && !scripted && !collaborationTool(call.name)) return undefined;
    if (call.status === 'succeeded' && (scripted || investigationTools.has(call.name))) readCalls++;
  }
  if (readCalls < (recentWindow ? investigationNudgeReadCalls : writeNudgeReadCalls)) return undefined;
  if (recentWindow) return { readCalls, text: `Runtime progress check: the last ${readCalls} tool calls continued project investigation. Reuse the evidence already collected. If it answers an analysis-only request, deliver the analysis; otherwise continue reading only to resolve a concrete missing fact. For implementation work, make the smallest useful edit once its entry point is known, or delegate an independent bounded outcome with the known paths and findings. Do not finish designing every module before starting independent work. This is advisory: further investigation may be necessary, and neither edits nor delegation are required for an analysis task. It does not change permissions or scope.` };
  return { readCalls, text: `Runtime progress check: this run has made ${readCalls} read/list/search calls and no edit or command yet. Earlier reads remain valid evidence even when they are no longer in context. Settle the design now and start saving edits incrementally with file.patch or file.apply_patch, then use the advertised checks; read further only for a specific edit you are about to make. This is execution feedback, not permission to widen access.` };
}

export function rereadNotice(paths: readonly string[]): string {
  return `Runtime progress check: ${paths.join(', ')} ${paths.length === 1 ? 'was' : 'were'} read ${rereadLimit} or more times with the same range and unchanged content. Reuse that evidence. If it answers the request, deliver your findings; for implementation work, make a focused edit when ready. Read again only to resolve a concrete uncertainty. This is advisory feedback, not a requirement to edit or permission to widen access.`;
}
