import { KodoError } from './types.js';

/**
 * Host compaction policy. Without `workInputTokens` compaction triggers at a
 * share of the effective window E = context window - output reserve, as Codex,
 * opencode and Gemini CLI do. `workInputTokens` keeps the legacy absolute work
 * budget H for existing hosts and frozen experiment scripts.
 */
export interface CompactionPolicy { strategy: 'mask' | 'summary' | 'hybrid'; workInputTokens?: number; triggerRatio?: number }

export const defaultTriggerRatio = 0.8;
/** Default capacity protection: inactive until the estimated input crosses 80% of the effective window. */
export const defaultCompactionPolicy: Readonly<CompactionPolicy> = Object.freeze({ strategy: 'summary', triggerRatio: defaultTriggerRatio });
/** Shares of E used by the ratio geometry; the summary installs at or below the target. */
const ratioShares = { target: 0.5, recent: 0.2, debounce: 0.7, maxSummaryTokens: 8192 } as const;
/** Legacy shares of the free space W = H - F (fixed prefix F). */
export const summaryGeometry = { recentShare: 0.3, installShare: 0.5, debounceShare: 0.7, minRoomTokens: 2048, maxSummaryTokens: 4096 } as const;

export function validateCompactionPolicy(policy: CompactionPolicy | undefined): void {
  if (policy === undefined) return;
  const fail = (): never => { throw new KodoError('COMPACTION_POLICY', 'compaction requires mask, summary or hybrid with either workInputTokens 1024-10000000 or triggerRatio 0.5-0.95'); };
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some(key => !['strategy', 'workInputTokens', 'triggerRatio'].includes(key)) || !['mask', 'summary', 'hybrid'].includes(policy.strategy)) fail();
  if (policy.workInputTokens !== undefined && (!Number.isSafeInteger(policy.workInputTokens) || policy.workInputTokens < 1024 || policy.workInputTokens > 10_000_000)) fail();
  if (policy.triggerRatio !== undefined && (typeof policy.triggerRatio !== 'number' || !Number.isFinite(policy.triggerRatio) || policy.triggerRatio < 0.5 || policy.triggerRatio > 0.95)) fail();
  if (policy.workInputTokens !== undefined && policy.triggerRatio !== undefined) fail();
}

/** Resolved token bounds of one context build. */
export interface CompactionGeometry {
  mode: 'ratio' | 'work';
  /** E for ratio mode, H for work mode. */
  effectiveTokens: number;
  /** Input above this starts pruning, masking and summary folding. */
  triggerTokens: number;
  /** Observation target after compaction; the hard window remains authoritative. */
  targetTokens: number;
  triggerRatio?: number;
  maxSummaryTokens: number;
}

/**
 * Trigger geometry for a window and its output reserve. `safeInput` already
 * subtracts the reserve and a small estimation margin; no trigger exceeds it.
 */
export function compactionGeometry(policy: { workInputTokens?: number; triggerRatio?: number }, window: { maxContextTokens: number; outputReserve: number; safeInput: number }): CompactionGeometry {
  if (policy.workInputTokens !== undefined) {
    if (!Number.isSafeInteger(policy.workInputTokens) || policy.workInputTokens < 1) throw new KodoError('CONTEXT_LIMIT', 'workInputTokens must be a positive integer');
    const trigger = Math.min(window.safeInput, policy.workInputTokens);
    return { mode: 'work', effectiveTokens: trigger, triggerTokens: trigger, targetTokens: Math.max(1, Math.floor(trigger * 0.70)), maxSummaryTokens: summaryGeometry.maxSummaryTokens };
  }
  const ratio = policy.triggerRatio ?? defaultTriggerRatio;
  const effective = Math.max(1, window.maxContextTokens - window.outputReserve);
  return {
    mode: 'ratio', effectiveTokens: effective, triggerRatio: ratio,
    triggerTokens: Math.max(1, Math.min(window.safeInput, Math.floor(effective * ratio))),
    targetTokens: Math.max(1, Math.floor(effective * ratioShares.target)),
    maxSummaryTokens: ratioShares.maxSummaryTokens,
  };
}

/** Legacy token bounds of the summary geometry for work budget H and fixed prefix F. */
export function summaryShares(workInputTokens: number, fixedTokens: number): { recentTokens: number; installTokens: number; debounceTokens: number } {
  const fixed = Math.min(Math.max(0, fixedTokens), workInputTokens);
  const free = workInputTokens - fixed;
  return {
    recentTokens: Math.floor(free * summaryGeometry.recentShare),
    installTokens: fixed + Math.floor(free * summaryGeometry.installShare),
    debounceTokens: fixed + Math.floor(free * summaryGeometry.debounceShare),
  };
}

/**
 * Recent tail, install target and debounce threshold. Ratio mode uses absolute
 * shares of E (tail 0.2E, install 0.5E, debounce min(0.7, ratio)E); work mode
 * keeps the legacy shares of the space left after the fixed prefix.
 */
export function geometryShares(geometry: CompactionGeometry, fixedTokens: number): { recentTokens: number; installTokens: number; debounceTokens: number } {
  if (geometry.mode === 'work') return summaryShares(geometry.triggerTokens, fixedTokens);
  const effective = geometry.effectiveTokens;
  return {
    recentTokens: Math.floor(effective * ratioShares.recent),
    installTokens: Math.floor(effective * ratioShares.target),
    debounceTokens: Math.floor(effective * Math.min(ratioShares.debounce, geometry.triggerRatio ?? defaultTriggerRatio)),
  };
}
