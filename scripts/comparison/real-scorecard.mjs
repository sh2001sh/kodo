export const historicRates = { currency: 'CNY', perMillion: { input: 0.5, cachedInput: 0.01, output: 2 }, sourceDate: '2026-10-20', source: 'docs/autonomous-performance-comparison.md', kind: 'historical public default-group recharge estimate; not account billing' };
const valid = value => Number.isSafeInteger(value) && value >= 0;
export function usageScorecard(wire, rates = historicRates.perMillion) {
  let input = 0, output = 0, cached = 0, cacheDenominator = 0, missingCacheInput = 0, unknown = 0, zero429 = 0;
  for (const call of wire.calls) {
    if (call.httpStatus === 429) { zero429++; continue; }
    const usage = call.usage;
    if (!valid(usage?.prompt_tokens) || !valid(usage?.completion_tokens)) { unknown++; continue; }
    input += usage.prompt_tokens; output += usage.completion_tokens;
    const hit = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? usage.cache_read_input_tokens;
    if (valid(hit) && hit <= usage.prompt_tokens) { cached += hit; cacheDenominator += usage.prompt_tokens; }
    else missingCacheInput += usage.prompt_tokens;
  }
  const cost = cache => ((input - cache) * rates.input + cache * rates.cachedInput + output * rates.output) / 1e6;
  return { requests: wire.requests, input, output, total: input + output, cached, cacheDenominator, cacheHitRate: cacheDenominator ? cached / cacheDenominator : null, missingCacheInput, unknownUsageRequests: unknown, zeroToken429: zero429, usageComplete: unknown === 0,
    estimatedCny: { low: cost(cached + missingCacheInput), high: cost(cached), complete: unknown === 0 },
    maxPromptTokens: Math.max(0, ...wire.calls.map(call => call.usage?.prompt_tokens ?? 0)), maxCompletionTokens: Math.max(0, ...wire.calls.map(call => call.usage?.completion_tokens ?? 0)),
  };
}
export function summarizeTrials(trials) {
  return [...new Set(trials.map(row => row.profile))].map(profile => {
    const rows = trials.filter(row => row.profile === profile); const success = rows.filter(row => row.acceptance.passed);
    const sum = fn => rows.reduce((total, row) => total + fn(row), 0);
    const seconds = sum(row => row.executionMs / 1000);
    const low = sum(row => row.usage.estimatedCny.low), high = sum(row => row.usage.estimatedCny.high);
    return { profile, attempts: rows.length, successes: success.length, completionRate: success.length / rows.length,
      meanRequirementCoverage: sum(row => row.acceptance.coverage) / rows.length, meanQualityScore: sum(row => row.acceptance.score) / rows.length,
      meanAttemptSeconds: seconds / rows.length, meanSuccessSeconds: success.length ? success.reduce((total, row) => total + row.executionMs / 1000, 0) / success.length : null,
      secondsPerSuccessfulDelivery: success.length ? seconds / success.length : null,
      totalRequests: sum(row => row.usage.requests), input: sum(row => row.usage.input), output: sum(row => row.usage.output), totalTokens: sum(row => row.usage.total),
      toolCalls: sum(row => row.tools.total), toolFailures: sum(row => row.tools.failed),
      estimatedTotalCny: { low, high, complete: rows.every(row => row.usage.usageComplete) }, estimatedCnyPerSuccess: success.length ? { low: low / success.length, high: high / success.length } : null,
      missingUsageRequests: sum(row => row.usage.unknownUsageRequests),
    };
  });
}
