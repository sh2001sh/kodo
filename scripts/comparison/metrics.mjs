const count = value => Number.isSafeInteger(value) && value >= 0;

// Provider usage plus the user's explicit HTTP 429 = zero-token accounting rule.
// Budget reservations stay separate from consumption.
export function collectMetrics(result) {
  const wire = result.wire;
  const contextWindowTokens = result.contextWindowTokens ?? 256000;
  let inputTokens = 0, outputTokens = 0, cachedInputTokens = 0, measuredRequests = 0, cacheReportedRequests = 0, zeroToken429Requests = 0;
  for (const call of wire.calls) {
    if (call.httpStatus === 429) { zeroToken429Requests++; continue; }
    const usage = call.usage;
    if (!count(usage?.prompt_tokens) || !count(usage?.completion_tokens)) continue;
    measuredRequests++;
    inputTokens += usage.prompt_tokens;
    outputTokens += usage.completion_tokens;
    const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.cached_tokens ?? usage.cache_read_input_tokens ?? usage.prompt_cache_hit_tokens;
    if (count(cached)) { cachedInputTokens += cached; cacheReportedRequests++; }
  }
  const tools = new Map();
  let toolCountComplete = true;
  if (result.profile === 'opencode') {
    toolCountComplete = result.outcome?.toolParts !== undefined;
    const parts = result.outcome?.toolParts ?? (result.outcome?.events ?? []).filter(event => event.type === 'tool_use').map(event => event.part);
    for (const part of parts) {
      const id = part.callID ?? part.id;
      if (!id) { toolCountComplete = false; continue; }
      tools.set(id, part.state?.status ?? 'unknown');
    }
  } else {
    for (const event of result.traceEvents ?? []) {
      if (!['tool.started', 'tool.finished'].includes(event.type)) continue;
      if (!event.callId) { toolCountComplete = false; continue; }
      tools.set(event.callId, event.type === 'tool.started' ? 'running' : event.status);
    }
    // Pi may reject a malformed/unknown call before entering our execute wrapper.
    for (const message of result.outcome?.messages ?? []) {
      if (message.role === 'tool' && message.tool_call_id && !tools.has(message.tool_call_id)) tools.set(message.tool_call_id, 'failed');
    }
  }
  const states = [...tools.values()];
  const toolCallsSucceeded = states.filter(status => ['succeeded', 'completed'].includes(status)).length;
  const toolCallsFailed = states.filter(status => ['failed', 'error', 'cancelled'].includes(status)).length;
  return {
    modelRequests: wire.requests, measuredRequests, zeroToken429Requests,
    tokenPolicy: 'HTTP 429 = 0 tokens, per user instruction; all other calls use provider usage',
    missingUsageRequests: wire.requests - measuredRequests - zeroToken429Requests,
    tokenUsageComplete: measuredRequests + zeroToken429Requests === wire.requests,
    providerUsageComplete: measuredRequests === wire.requests,
    inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
    cachedInputTokens: cacheReportedRequests || zeroToken429Requests === wire.requests ? cachedInputTokens : null,
    cacheUsageComplete: cacheReportedRequests + zeroToken429Requests === wire.requests,
    budgetAccountedTokens: wire.tokens, budgetIncludesEstimates: wire.estimated,
    toolCalls: tools.size, toolCallsSucceeded, toolCallsFailed,
    toolCallsUnfinished: tools.size - toolCallsSucceeded - toolCallsFailed, toolCountComplete,
    toolExecutions: result.profile.startsWith('kodo-') ? result.session?.toolCalls : result.profile.startsWith('pi-') ? result.outcome?.stats?.toolCalls : null,
    executionMs: result.executionMs ?? null, evaluationTotalMs: result.elapsedMs,
    maxPromptTokens: Math.max(0, ...wire.calls.map(call => call.usage?.prompt_tokens ?? 0)),
    maxContextChars: Math.max(0, ...wire.calls.map(call => call.contextChars ?? 0)),
    contextWindowTokens,
    contextWindowUsageVerified: measuredRequests > 0 && measuredRequests + zeroToken429Requests === wire.requests
      && wire.calls.every(call => call.httpStatus === 429 || call.usage.prompt_tokens + (call.outputLimit ?? 3072) <= contextWindowTokens),
    rejected: wire.rejected,
  };
}

export function aggregateMetrics(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.task}/${row.profile}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(attempts => {
    const succeeded = attempts.filter(row => row.passed);
    const measured = succeeded.filter(row => row.metrics.tokenUsageComplete);
    const average = (items, key) => items.length ? items.reduce((sum, row) => sum + row.metrics[key], 0) / items.length : null;
    const sum = (items, key) => items.reduce((total, row) => total + row.metrics[key], 0);
    const failed = attempts.filter(row => !row.passed);
    return { task: attempts[0].task, profile: attempts[0].profile, attempts: attempts.length, successes: succeeded.length,
      successMean: { modelRequests: average(succeeded, 'modelRequests'), toolCalls: succeeded.every(row => row.metrics.toolCountComplete) ? average(succeeded, 'toolCalls') : null,
        inputTokens: average(measured, 'inputTokens'), outputTokens: average(measured, 'outputTokens'), totalTokens: average(measured, 'totalTokens'),
        cachedInputTokens: succeeded.every(row => row.metrics.cacheUsageComplete) ? average(succeeded, 'cachedInputTokens') : null,
        executionMs: succeeded.every(row => row.metrics.executionMs !== null) ? average(succeeded, 'executionMs') : null },
      tokenMeanSamples: measured.length,
      failedCost: { attempts: failed.length, modelRequests: sum(failed, 'modelRequests'), toolCalls: sum(failed, 'toolCalls'),
        measuredTokens: sum(failed, 'totalTokens'), missingUsageRequests: sum(failed, 'missingUsageRequests') },
    };
  });
}
