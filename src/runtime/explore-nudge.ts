import type { Store } from '../storage/index.js';
import type { Run } from './types.js';

/** Evaluated threshold for hosts that opt in; the coordinator leaves the nudge off by default. */
export const exploreNudgeReadCalls = 8;
const investigationTools = new Set(['file.read', 'file.list', 'file.search']);
const delegationTools = new Set(['explore', 'spawn_agent']);

/**
 * Runtime delegation check for a main run: after `threshold` successful direct
 * reads without any delegation, return a one-time suggestion to hand remaining
 * independent or unfamiliar investigation to explore. The caller records the
 * `delegation.nudged` event together with the context update.
 */
export function exploreNudge(store: Store, run: Run, threshold: number): { text: string; readCalls: number } | undefined {
  if (run.parentId || store.hasEvent(run.id, { types: ['delegation.nudged'] })) return undefined;
  // Materialized call counters keep this check constant-time as the run grows.
  if (store.countCalls(run.id, { kind: 'tool', name: [...delegationTools] })) return undefined;
  const readCalls = store.countCalls(run.id, { kind: 'tool', name: [...investigationTools], status: 'succeeded' });
  if (readCalls < threshold) return undefined;
  return { readCalls, text: `Runtime delegation check: this run has made ${readCalls} direct read/list/search calls and has not delegated. If questions remain that need more reading in unfamiliar areas or are independent of each other, hand them to explore now (up to 4 parallel read-only tasks; only their reports enter your context) and keep only the integration for yourself. If what remains is a few known reads, continue directly. This is guidance, not permission to widen scope.` };
}
