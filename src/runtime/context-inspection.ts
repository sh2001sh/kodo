import { attachmentKind } from './attachments.js';
import { Store, digest } from '../storage/index.js';
import { createInputTokenEstimator, estimateInputTokens } from './context-tokens.js';
import { recoveryHistoryRuns } from './history.js';
import type { AssemblyPolicy, CompactionPolicy } from './context.js';
import { readSummaryEnvelope } from './summary-read.js';
import type { Message, ModelResponse, Provider, Run, ToolSpec } from './types.js';

export type ContextLayer = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7';
const contextLayers: ContextLayer[] = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'];

/** Frozen layers end at the objective; later instructions/environment changes are history. */
export function splitContextLayers(messages: Message[]): Record<ContextLayer, Message[]> {
  const result: Record<ContextLayer, Message[]> = { L1: [], L2: [], L3: [], L4: [], L5: [], L6: [], L7: [] };
  let history = false;
  for (const message of messages) {
    const kind = attachmentKind(message);
    if (kind === 'state' && message === messages.at(-1)) { result.L7.push(message); continue; }
    if (history) { result.L6.push(message); continue; }
    if (message.role === 'system') result[message.content.startsWith('Agent method configuration') ? 'L2' : 'L1'].push(message);
    else if (kind === 'agents') result.L2.push(message);
    else if (kind === 'project-instructions') result.L3.push(message);
    else if (kind === 'environment') result.L4.push(message);
    else { result.L5.push(message); history = true; }
  }
  return result;
}

/** Estimated accounting; layer totals plus protocol/calibration equal the complete request estimate. */
export function measureContextLayers(store: Store, run: Run, messages: Message[], tools: ToolSpec[]) {
  const groups = splitContextLayers(messages);
  const estimator = createInputTokenEstimator(store, run, []);
  const base = estimator.estimate([]);
  const layers = Object.fromEntries(contextLayers.map(layer => [layer, groups[layer].length ? estimator.estimate(groups[layer]) - base : 0])) as Record<ContextLayer, number>;
  const toolTokens = estimateInputTokens(store, run, [], tools) - base;
  const estimatedInputTokens = estimateInputTokens(store, run, messages, tools);
  const attachments = messages.filter(message => attachmentKind(message) !== undefined);
  return {
    layers, tools: toolTokens, estimatedInputTokens,
    protocolAndCalibration: estimatedInputTokens - toolTokens - Object.values(layers).reduce((sum, value) => sum + value, 0),
    // This is a subset of the layers, not another additive charge.
    attachmentTokens: attachments.length ? estimator.estimate(attachments) - base : 0,
    instructionsDigest: digest(JSON.stringify(messages.filter(message => attachmentKind(message) === 'project-instructions'))),
    estimated: true,
  };
}

/** Compare actual request prefixes; equal later layers do not imply reusable provider cache. */
export function compareContextPrefixes(parent: Pick<Parameters<Provider['complete']>[0], 'messages' | 'tools'>, child: Pick<Parameters<Provider['complete']>[0], 'messages' | 'tools'>) {
  const left = splitContextLayers(parent.messages);
  const right = splitContextLayers(child.messages);
  const equal = Object.fromEntries(contextLayers.map(layer => [layer, JSON.stringify(left[layer]) === JSON.stringify(right[layer])])) as Record<ContextLayer, boolean>;
  const common = (a: string, b: string): number => { let index = 0; while (index < a.length && index < b.length && a[index] === b[index]) index++; return index; };
  const toolsEqual = JSON.stringify(parent.tools) === JSON.stringify(child.tools);
  return {
    layersEqual: equal, toolsEqual,
    sharedRuleChars: common(parent.messages[0]?.content ?? '', child.messages[0]?.content ?? ''),
    commonPrefixChars: common(JSON.stringify({ tools: parent.tools, messages: parent.messages }), JSON.stringify({ tools: child.tools, messages: child.messages })),
    note: 'Character overlap of canonical tools/messages, not provider wire tokens or cache hits. A differing earlier layer ends prefix reuse; actual hits come from provider cacheRead.',
  };
}

/** Host-side aggregation over a set of runs; no model call and no mutation. */
export function aggregateUsage(store: Store, owners: Run[]) {
  const result = { modelCalls: 0, summaryCalls: 0, knownInput: 0, knownOutput: 0, cacheRead: 0, cacheWrite: 0, unknownCalls: 0, reservedUnknownTokens: 0, peakInput: 0, estimatedPeakInput: 0, recoveryReads: 0 };
  for (const owner of owners) for (const call of store.calls(owner.id)) {
    if (call.kind === 'tool') { if (['history.read', 'history.search', 'inspect_run', 'knowledge.read'].includes(call.name)) result.recoveryReads++; continue; }
    result.modelCalls++;
    if (call.purpose === 'compaction') result.summaryCalls++;
    const request = store.readBlob<Parameters<Provider['complete']>[0]>(call.requestRef);
    result.estimatedPeakInput = Math.max(result.estimatedPeakInput, estimateInputTokens(store, owner, request.messages, request.tools));
    const response = call.resultRef ? store.readBlob<{ usage?: ModelResponse['usage'] | string; settledTokens?: number }>(call.resultRef) : undefined;
    if (response?.usage && typeof response.usage === 'object') {
      result.knownInput += response.usage.input; result.knownOutput += response.usage.output;
      result.cacheRead += response.usage.cacheRead ?? 0; result.cacheWrite += response.usage.cacheWrite ?? 0;
      result.peakInput = Math.max(result.peakInput, response.usage.input);
    } else if (response?.settledTokens !== 0 && response?.usage !== 'known-zero') {
      result.unknownCalls++; result.reservedUnknownTokens += call.reservedTokens;
    }
  }
  return result;
}

/** Read-only host report for one run; inspecting a context never compacts it or calls a model. */
export function inspectContext(store: Store, run: Run, tools: ToolSpec[], policy?: CompactionPolicy, assemblyPolicy?: AssemblyPolicy) {
  const messages = store.readBlob<Message[]>(run.contextRef);
  const events = recoveryHistoryRuns(store, run).flatMap(owner => store.events(owner.id)).sort((a, b) => a.seq - b.seq);
  const states = new Set(events.filter(event => event.type === 'context.state').map(event => event.data.text));
  const markers = new Set(events.filter(event => event.type === 'context.summary.installed').map(event => event.data.marker));
  const parts = { rules: 0, tools: 0, state: 0, summary: 0, recent: 0, protocolAndCalibration: 0 };
  const estimator = createInputTokenEstimator(store, run, []);
  const base = estimator.estimate([]);
  for (const message of messages) {
    const category = markers.has(message.content) ? 'summary' : states.has(message.content) || attachmentKind(message) === 'environment' || attachmentKind(message) === 'state' || (message.role === 'system' && message.content.startsWith('Current decision version:')) || (message.role === 'user' && /^(Task progress |Current run task list )/.test(message.content)) ? 'state' : message.role === 'user' || message.role === 'system' ? 'rules' : 'recent';
    parts[category] += estimator.estimate([message]) - base;
  }
  parts.tools = estimateInputTokens(store, run, [], tools) - base;
  const estimatedInputTokens = estimateInputTokens(store, run, messages, tools);
  parts.protocolAndCalibration = estimatedInputTokens - Object.values(parts).reduce((sum, value) => sum + value, 0);
  const installed = events.findLast(event => event.type === 'context.summary.installed' && markers.has(event.data.marker) && messages.some(message => message.content === event.data.marker));
  const envelope = installed ? readSummaryEnvelope(store, installed.data.summaryRef as string) : undefined;
  const latest = events.findLast(event => ['context.compacted', 'context.summary.installed'].includes(event.type));
  const latestAssembly = events.findLast(event => event.type === 'context.assembled');
  return {
    runId: run.id, experimental: true, policy: policy ?? null, assemblyPolicy: assemblyPolicy ?? null, estimatedInputTokens, parts,
    layers: measureContextLayers(store, run, messages, tools),
    lastRequestLayers: store.latestEvent(run.id, { types: ['context.request_measured'] })?.data ?? null,
    prefixSharing: store.latestEvent(run.id, { types: ['child.prefix_shared'] })?.data ?? null,
    modelLimits: run.modelLimits ?? store.session(run.sessionId).modelLimits,
    messageCount: messages.length,
    hiddenObservations: messages.filter(message => message.role === 'tool' && message.content.includes('"contextHidden":true')).length,
    latestCompaction: latest ? { type: latest.type, time: latest.time, beforeTokens: latest.data.beforeTokens, afterTokens: latest.data.afterTokens, targetMet: latest.data.targetMet, archivedRef: latest.data.archivedRef } : null,
    latestAssembly: latestAssembly ? { time: latestAssembly.time, beforeTokens: latestAssembly.data.beforeTokens, afterTokens: latestAssembly.data.afterTokens, evidenceInputTokens: latestAssembly.data.evidenceInputTokens, usedEvidenceTokens: latestAssembly.data.usedEvidenceTokens, candidateGroups: latestAssembly.data.candidateGroups, selectedGroups: latestAssembly.data.selectedGroups, selectedSourceIds: latestAssembly.data.selectedSourceIds, selectedOffsets: latestAssembly.data.selectedOffsets, hiddenOffsets: latestAssembly.data.hiddenOffsets, restoredOffsets: latestAssembly.data.restoredOffsets, archivedRef: latestAssembly.data.archivedRef } : null,
    summary: envelope ? { ref: installed!.data.summaryRef, ...envelope } : null,
    usage: aggregateUsage(store, recoveryHistoryRuns(store, run)), sessionUsage: aggregateUsage(store, store.listRuns(run.sessionId)),
    note: 'Token breakdown is estimated; protocolAndCalibration reconciles framing and measured-prefix calibration. Unknown usage retains reservations and is not billing. Hidden observations are retained, not deleted. Summaries are lossy historical claims, not acceptance.',
  };
}

/**
 * C0 aggregation report across every run of a session. It reuses the same host
 * counters as inspectContext but never assembles or modifies model input.
 */
export function inspectContextReport(store: Store, run: Run) {
  const sessionId = run.sessionId;
  const runs = store.listRuns(sessionId).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const events = runs.flatMap(owner => store.events(owner.id)).sort((left, right) => left.seq - right.seq);
  const count = (type: string): number => events.filter(event => event.type === type).length;
  let hiddenObservations = 0;
  for (const owner of runs) {
    try { hiddenObservations += store.readBlob<Message[]>(owner.contextRef).filter(message => message.role === 'tool' && message.content.includes('"contextHidden":true')).length; }
    catch { /* a corrupted projection is reported by inspection on its own run, not guessed here */ }
  }
  const summaries = events.filter(event => event.type === 'context.summary.installed');
  return {
    runId: run.id,
    sessionId,
    experimental: true,
    runCount: runs.length,
    runs: runs.map(owner => ({ id: owner.id, status: owner.status, createdAt: owner.createdAt, objective: owner.objective, continuationOf: owner.continuationOf ?? null, error: owner.error ?? null })),
    usage: aggregateUsage(store, runs),
    compaction: {
      events: {
        assembled: count('context.assembled'),
        compacted: count('context.compacted'),
        summaryStarted: count('context.summary.started'),
        summaryInstalled: summaries.length,
        summaryFailed: count('context.summary.failed'),
        summarySkipped: count('context.summary.skipped'),
        summaryDiscarded: count('context.summary.discarded'),
        summaryDisabled: count('context.summary.disabled'),
      },
      latestSummaryRef: summaries.at(-1)?.data.summaryRef ?? null,
      runsWithCompaction: new Set(events.filter(event => ['context.compacted', 'context.summary.installed'].includes(event.type)).map(event => event.runId)).size,
    },
    hiddenObservations,
    note: 'Cross-run host aggregate over one session. Counters are recorded usage, not billing; missing usage stays unknown rather than being estimated as zero.',
  };
}

export type ContextUsage = ReturnType<typeof aggregateUsage>;
export type ContextReport = ReturnType<typeof inspectContextReport>;
