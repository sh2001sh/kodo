import { KodoError } from './types.js';
import type { Budget, ModelResponse } from './types.js';

/** Default share of cache-read input tokens charged against `maxTokens`; 100 keeps full-price accounting. */
export const defaultCacheReadCostPercent = 100;

/**
 * Tokens one completed model call charges against the shared token budget.
 * Cache-read input is charged at `cacheReadCostPercent` (rounded up), so hosts
 * whose providers bill cached prefixes at a discount can budget by cost instead
 * of raw volume. Uncached input, cache writes and output are charged in full.
 */
export function chargedTokens(usage: NonNullable<ModelResponse['usage']>, budget: Pick<Budget, 'cacheReadCostPercent'>): number {
  const percent = budget.cacheReadCostPercent ?? defaultCacheReadCostPercent;
  const cacheRead = usage.cacheRead ?? 0;
  return usage.input - cacheRead + Math.ceil(cacheRead * percent / 100) + usage.output;
}

/** How a failed attempt is settled: measured usage, known zero, or unknown with the reservation kept. */
export interface FailureSettlement { settledTokens: number; estimated: boolean; usage: NonNullable<ModelResponse['usage']> | 'known-zero' | 'unknown; reservation retained'; knownZero: boolean }

/**
 * Measured usage reported before a failure (e.g. an output-limit stop) wins over the
 * known-zero flag; without either the reservation stays charged and the total is estimated.
 */
export function failureSettlement(error: unknown, reservedTokens: number, budget: Pick<Budget, 'cacheReadCostPercent'>): FailureSettlement {
  const metadata = error instanceof KodoError ? error.metadata : undefined;
  if (metadata?.usage) return { settledTokens: chargedTokens(metadata.usage, budget), estimated: false, usage: metadata.usage, knownZero: false };
  if (metadata?.usageKnownZero === true) return { settledTokens: 0, estimated: false, usage: 'known-zero', knownZero: true };
  return { settledTokens: reservedTokens, estimated: true, usage: 'unknown; reservation retained', knownZero: false };
}
