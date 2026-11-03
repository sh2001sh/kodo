import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { collaborationTool } from '../messaging/index.js';
import { buildContext } from './context.js';
import { recordMethodUnloading } from './method-context.js';
import type { ContextBuild } from './context.js';
import { recordSkip, summarizeContext } from './compaction.js';
import { estimateInputTokens } from './context-tokens.js';
import { attachment } from './attachments.js';
import { compareContextPrefixes, measureContextLayers } from './context-inspection.js';
import { refreshInstructions } from './instruction-layer.js';
import { RequiredInputOverflow } from './context-hard.js';
import { contextOutputReserve, validateModelBinding } from '../providers/model-limits.js';
import { handoffFailure } from './progress-advisor.js';
import { repairResponse } from './response-repair.js';
import { runBudget } from './run-budget.js';
import { environmentBlock, leanStateFrame, stateFrame, withEnvironment } from './state-frame.js';
import { isLeanProfile } from './tool-view.js';
import { effectiveSession, toolSpecs } from './step-host.js';
import { canonicalRequest } from './tool-view.js';
import { timeHint } from './lean-prompt.js';
import type { StepHost } from './step-host.js';
import { chargedTokens, failureSettlement } from './usage.js';
import { errorText, KodoError, terminal } from './types.js';
import type { Call, Message, ModelResponse, Provider, Run, StepOutcome } from './types.js';

type Request = Parameters<Provider['complete']>[0];
interface Prepared { request: Request; requestRef: string; version?: number }
interface Overflow { overflow: string; reason: string }
interface OutputLimit { outputLimit: string }
interface Lease { release?: () => void }
/** Prefixes of the system messages earlier versions stored and refreshed in place. */
const legacySystemPrefixes = ['Current decision version:', 'Current execution environment:', 'Kernel execution state: '];

/**
 * Minute-scale transport backoff: the first retry waits about 30s and the second
 * about 60s, so a short gateway outage no longer kills a long task. A provider
 * retry-after can only lengthen the wait; the session duration budget still caps
 * the total. Recorded event delays are always these production values.
 */
export function transportBackoffMs(transientAttempt: number, retryAfterMs?: number): number {
  const base = transientAttempt <= 0 ? 30_000 : 60_000;
  return retryAfterMs === undefined ? base : Math.max(base, retryAfterMs);
}

/** Host/test seam: KODO_TEST_RETRY_DELAY_MS caps the real wait but never the recorded delay. */
function retryWaitCeiling(): number | undefined {
  const raw = process.env.KODO_TEST_RETRY_DELAY_MS;
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Consumes delivered input, refreshes the runtime blocks and compacts the stored
 * context. `force` is overflow recovery: compact toward the target and ignore the
 * summary debounce; hosts without a policy get the mask projection.
 */
export function prepareContext(host: StepHost, runId: string, force = false): ContextBuild {
  const { store } = host;
  return store.transaction(() => {
    const run = store.run(runId);
    const pending = store.inbox(runId);
    const session = store.session(run.sessionId);
    // Legacy contexts stored the environment and state as mutable system messages.
    const delivered = store.readBlob<Message[]>(run.contextRef).filter(message => message.role !== 'system' || !legacySystemPrefixes.some(prefix => message.content.startsWith(prefix)));
    for (const message of pending) delivered.push(message.from === 'user'
      ? { role: 'user', content: `User input: ${JSON.stringify(message)}` }
      : attachment(message.from === 'runtime' && message.kind === 'event' ? 'task-notification' : 'mailbox', JSON.stringify(message), { source: message.from === 'runtime' ? 'runtime' : 'peer' }));
    const changedInstructions = refreshInstructions(store, run, session);
    if (changedInstructions) delivered.push(changedInstructions);
    // A lean main run gets one durable closing hint per crossed time threshold.
    const hint = isLeanProfile(session.toolProfile) ? timeHint(host, run, session) : undefined;
    if (hint) delivered.push(hint);
    // L4 joins the frozen prefix once; a changed environment is appended after the new input.
    const context = withEnvironment(delivered, environmentBlock(host, run, session));
    if (run.step === 0 && run.continuationOf && !run.historyFrom) context.push({ role: 'user', content: `Previous run ${run.continuationOf}: ${JSON.stringify(host.mailbox.result(store.run(run.continuationOf)))}` });
    const specs = toolSpecs(host, run, session);
    const next = { ...run, contextRef: store.blob(context) };
    const budget = runBudget(run, session);
    const compaction = force ? host.compaction ?? { strategy: 'mask' as const } : host.compaction;
    const capacity = Math.min(run.modelLimits?.input ?? session.modelLimits?.input ?? Infinity, budget.maxContextTokens - contextOutputReserve(budget));
    // Reserve the pressure-bearing shape whenever compaction can produce it.
    // Window-sized numbers cover the final counters without a second fixed budget.
    const state = stateFrame(host, run, session, compaction ? { inputTokens: budget.maxContextTokens, triggerTokens: budget.maxContextTokens - 1, hardCapacityTokens: capacity } : undefined);
    const stateTokens = estimateInputTokens(store, run, [state], specs) - estimateInputTokens(store, run, [], specs);
    const built = buildContext(store, next, budget.maxContextChars === null ? null : Math.max(0, budget.maxContextChars - JSON.stringify(state).length - 1), specs, { maxContextTokens: budget.maxContextTokens, maxOutputTokens: contextOutputReserve(budget), maxInputTokens: Math.max(0, capacity - stateTokens), compaction, assembly: host.assembly, force });
    store.updateRun(runId, { contextRef: store.blob(built.messages), inputCursor: pending.at(-1)?.seq ?? run.inputCursor ?? 0, decisionVersion: session.decisionVersion ?? 0, waitId: undefined });
    recordMethodUnloading(store, runId, built.methodUnloading);
    if (built.archivedRef) {
      store.event(runId, 'context.compacted', { archivedRef: built.archivedRef, previousRef: built.previousRef, originalChars: built.originalChars, compactedChars: built.compactedChars, omittedMessages: built.omittedMessages, prunedMessages: built.prunedMessages ?? 0, strategy: built.strategy, beforeTokens: built.originalInputTokens, afterTokens: built.estimatedInputTokens, workInputTokens: built.workInputTokens, triggerRatio: built.geometry?.triggerRatio, targetTokens: built.targetTokens, targetMet: built.targetMet, ...(built.hardTargetTokens ? { hardTargetTokens: built.hardTargetTokens } : {}), ...(force ? { forced: true } : {}) });
    }
    if (built.assembly) store.event(runId, 'context.assembled', { ...built.assembly });
    return built;
  });
}

/** Compacts (and summarizes when planned), then snapshots a new request with all tools. */
async function buildRequest(host: StepHost, runId: string, signal: AbortSignal, force: boolean): Promise<Prepared | Overflow> {
  const { store } = host;
  let built = prepareContext(host, runId, force);
  if (built.summarySkipped) recordSkip(store, runId, { ...built.summarySkipped });
  if (built.summaryPlan) {
    const latest = store.run(runId);
    const current = store.session(latest.sessionId);
    await summarizeContext({ store, run: latest, built, budget: runBudget(latest, current), tools: toolSpecs(host, latest, current), provider: host.provider, signal, hooks: host.hooks });
    signal.throwIfAborted();
    // Messages and child completions arriving during generation remain durable and are consumed now.
    built = prepareContext(host, runId, force);
  }
  const run = store.run(runId);
  const session = store.session(run.sessionId);
  const budget = runBudget(run, session);
  const specs = toolSpecs(host, run, session);
  // L7 is regenerated for every request and never stored in conversational history.
  const stored = store.readBlob<Message[]>(run.contextRef);
  const hardCapacityTokens = Math.min(run.modelLimits?.input ?? session.modelLimits?.input ?? Infinity, budget.maxContextTokens - contextOutputReserve(budget));
  // Benchmark-only ablation (KODO_ABLATION=no-state): send requests without the L7 frame.
  const lean = isLeanProfile(session.toolProfile) && !run.parentId;
  const frame = (pressure?: Parameters<typeof stateFrame>[3]): Message | undefined => lean ? leanStateFrame(host, run, session, pressure) : stateFrame(host, run, session, pressure);
  const withoutState = process.env.KODO_ABLATION === 'no-state';
  let state = withoutState ? undefined : frame();
  const messages = state ? [...stored, state] : [...stored];
  let input = estimateInputTokens(store, run, messages, specs);
  if (!withoutState && built.geometry && input > built.geometry.triggerTokens) {
    // Include the frame's own estimated tokens in pressure feedback. At most
    // three passes settle the counter's digit width; no history is rebuilt.
    for (let pass = 0; pass < 3; pass++) {
      const next = frame({ inputTokens: input, triggerTokens: built.geometry.triggerTokens, hardCapacityTokens });
      if (state && next) messages[messages.length - 1] = next;
      else if (next) messages.push(next);
      state = next ?? state;
      const nextInput = estimateInputTokens(store, run, messages, specs);
      if (nextInput === input) break;
      input = nextInput;
    }
  }
  if (state && store.latestEvent(run.id, { types: ['context.state'] })?.data.text !== state.content) store.event(run.id, 'context.state', { text: state.content });
  if (input > (run.modelLimits?.input ?? session.modelLimits?.input ?? Infinity)) return { overflow: 'CONTEXT_LIMIT', reason: 'the complete request including the state frame exceeds the model input limit' };
  if (budget.maxContextChars !== null && JSON.stringify({ messages, tools: specs }).length > budget.maxContextChars) return { overflow: 'CONTEXT_LIMIT', reason: 'the complete request including the state frame exceeds the host character limit' };
  const windowRoom = budget.maxContextTokens - input;
  if (windowRoom < 1) return { overflow: 'CONTEXT_LIMIT', reason: 'estimated input leaves no output capacity within the model token window' };
  // Output is bounded by the model, the window and an explicit host token cap only.
  const spendRoom = session.budget.maxTokens === null ? Infinity : session.budget.maxTokens - session.tokens - input;
  const output = Math.min(budget.maxOutputTokens, windowRoom, spendRoom);
  if (output < 1) throw new KodoError('MODEL_BUDGET', 'input leaves no output capacity within the explicit session token limit');
  const request: Request = { binding: run.binding, messages, tools: specs, maxOutputTokens: output, ...(run.toolChoice ? { toolChoice: run.toolChoice } : {}), ...(run.binding.promptCache === 'session' ? { cacheKey: run.sessionId } : {}) };
  return { request, requestRef: store.blob(request), version: run.decisionVersion };
}

function validResponse(request: Request, response: ModelResponse): boolean {
  const calls = response.message.tool_calls ?? [];
  const usage = response.usage;
  return ['stop', 'tool_calls'].includes(response.finishReason)
    && (response.finishReason === 'tool_calls') === Boolean(calls.length) && !(request.toolChoice === 'none' && calls.length > 0) && calls.length <= 32
    && new Set(calls.map(x => x.id)).size === calls.length && !calls.some(x => !x.id || x.id.length > 256 || !x.name)
    && !(usage && ([usage.input, usage.output, usage.cacheRead ?? 0, usage.cacheWrite ?? 0].some(x => !Number.isSafeInteger(x) || x < 0) || (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) > usage.input));
}

/** Reserves shared spending for one attempt; only explicit host caps can reject it. */
function startAttempt(host: StepHost, run: Run, prepared: Prepared, reserve: number, attempt: number, signal: AbortSignal,
  routing?: { logicalRequestRef: string; routeIndex: number; change?: { from: string; to: string; model: string; reason: string } }): Call {
  const { store } = host;
  const modelCall: Call = {
    id: randomUUID(), runId: run.id, step: run.step, kind: 'model', name: prepared.request.binding.model,
    status: 'running', effect: 'read', requestRef: prepared.requestRef, reservedTokens: reserve, decisionVersion: prepared.version,
    ...(routing ? { logicalRequestRef: routing.logicalRequestRef, routeIndex: routing.routeIndex } : {}),
  };
  store.transaction(() => {
    const latest = store.session(run.sessionId);
    signal.throwIfAborted();
    if (terminal(store.run(run.id).status) || store.run(run.id).status === 'interrupted') throw new KodoError('RECOVERY_REQUIRED', 'run no longer has execution authority');
    if ((latest.budget.maxModelCalls !== null && latest.modelCalls >= latest.budget.maxModelCalls) || (latest.budget.maxTokens !== null && latest.tokens + reserve > latest.budget.maxTokens)) throw new KodoError('MODEL_BUDGET', 'model call or token budget exhausted');
    store.putSession({ ...latest, modelCalls: latest.modelCalls + 1, tokens: latest.tokens + reserve });
    store.putCall(modelCall);
    store.updateRun(run.id, { stepCallId: modelCall.id });
    store.event(run.id, 'model.started', { callId: modelCall.id, requestRef: prepared.requestRef, attempt: attempt + 1, reservedTokens: reserve,
      ...(routing ? { logicalRequestRef: routing.logicalRequestRef, routeIndex: routing.routeIndex, provider: prepared.request.binding.provider ?? null } : {}) });
    if (routing?.change) store.event(run.id, 'model.provider_changed', { callId: modelCall.id, ...routing.change, costChange: 'unknown' });
    store.event(run.id, 'context.request_measured', { callId: modelCall.id, requestRef: prepared.requestRef, ...measureContextLayers(store, run, prepared.request.messages, prepared.request.tools) });
    if (run.parentId && !store.hasEvent(run.id, { types: ['child.prefix_shared'] })) {
      const parent = store.recentModelCalls(run.parentId, 1)[0];
      store.event(run.id, 'child.prefix_shared', parent ? {
        parentRunId: run.parentId, parentRequestRef: parent.requestRef, childRequestRef: prepared.requestRef,
        ...compareContextPrefixes(store.readBlob<Request>(parent.requestRef), prepared.request),
      } : { parentRunId: run.parentId, childRequestRef: prepared.requestRef, available: false, reason: 'parent has no recorded completed model request' });
    }
  });
  return modelCall;
}

/**
 * Settles a failed attempt in one of three states: measured (the provider reported
 * usage before failing), known-zero, or unknown (the reservation stays charged).
 */
function recordFailure(host: StepHost, run: Run, modelCall: Call, error: unknown, signal: AbortSignal): void {
  const { store } = host;
  store.transaction(() => {
    const latest = store.session(run.sessionId);
    const settlement = failureSettlement(error, modelCall.reservedTokens, latest.budget);
    const resultRef = store.blob({ error: errorText(error), usage: settlement.usage, ...(!settlement.estimated ? { settledTokens: settlement.settledTokens } : {}) });
    store.putSession({ ...latest, tokens: latest.tokens - modelCall.reservedTokens + settlement.settledTokens, usageEstimated: latest.usageEstimated || settlement.estimated });
    store.putCall({ ...modelCall, status: signal.aborted ? 'cancelled' : 'failed', resultRef });
    store.event(run.id, 'model.failed', { callId: modelCall.id, error: errorText(error), usageKnownZero: settlement.knownZero, usage: typeof settlement.usage === 'object' ? settlement.usage : null, reservedTokens: modelCall.reservedTokens, ...(!settlement.estimated ? { chargedTokens: settlement.settledTokens } : {}),
      ...(error instanceof KodoError && error.metadata?.incompleteStream ? { incompleteStream: true, requestRef: modelCall.requestRef } : {}),
    });
  });
}

function recordSuccess(host: StepHost, run: Run, modelCall: Call, response: ModelResponse): void {
  const { store } = host;
  // A renamed view call is recorded by its canonical kernel request; the model's own call is kept beside it.
  const session = effectiveSession(run, store.session(run.sessionId));
  const calls = (response.message.tool_calls ?? []).map(call => ({ model: call, kernel: canonicalRequest(run, session, call).request }));
  const responseRef = store.blob(response);
  const callRefs = calls.map(call => store.blob(call.kernel));
  store.transaction(() => {
    const latest = store.session(run.sessionId);
    const measured = response.usage ? chargedTokens(response.usage, latest.budget) : modelCall.reservedTokens;
    store.putSession({ ...latest, tokens: latest.tokens - modelCall.reservedTokens + measured, usageEstimated: latest.usageEstimated || !response.usage });
    store.putCall({ ...modelCall, status: 'succeeded', resultRef: responseRef });
    for (const [index, { model, kernel: call }] of calls.entries()) store.putCall({
      id: `${modelCall.id}:${call.id}`, runId: run.id, step: run.step, kind: 'tool', name: call.name,
      status: 'planned', effect: host.tools.effect(call.name), effectState: 'not_started', requestRef: callRefs[index]!, reservedTokens: 0,
      ...(model !== call ? { modelRequestRef: store.blob(model) } : {}),
      ...(!collaborationTool(call.name) ? { evidencePermission: host.tools.permission(call.name) } : {}),
      decisionVersion: modelCall.decisionVersion ?? 0,
    });
    store.event(run.id, 'model.finished', { callId: modelCall.id, usage: response.usage ?? null, estimated: !response.usage, chargedTokens: measured });
  });
}

/**
 * One bounded recovery for an output-limit stop. Reasoning and answer share the
 * output cap, so a stop can recur deterministically for the same request; this
 * only absorbs occasional overruns and is not a fix for an undersized output cap.
 */
function outputLimitRetry(host: StepHost, run: Run, prepared: Prepared, error: unknown): boolean {
  if (!(error instanceof KodoError) || error.metadata?.outputLimit !== true) return false;
  return !host.store.hasEvent(run.id, { types: ['model.retry'], match: { reason: 'output_limit', requestRef: prepared.requestRef } });
}

/** Discard an unterminated response once, without replaying visible text or switching endpoints. */
function incompleteStreamRetry(host: StepHost, run: Run, prepared: Prepared, error: unknown, emitted: boolean): boolean {
  return !emitted && error instanceof KodoError && error.code === 'MODEL_INCOMPLETE'
    && error.metadata?.incompleteStream === true && !error.metadata.outputLimit
    && !host.store.hasEvent(run.id, { types: ['model.retry'], match: { reason: 'incomplete_stream', requestRef: prepared.requestRef } });
}

/** Each configured endpoint owns its own reservation and durable physical request. */
async function callProviderGroup(host: StepHost, run: Run, prepared: Prepared, reserve: number, lease: Lease, signal: AbortSignal): Promise<'done' | Overflow | OutputLimit | StepOutcome> {
  const { store } = host;
  validateModelBinding(prepared.request.binding);
  const { fallbacks, ...primary } = prepared.request.binding;
  const routes = [primary, ...fallbacks ?? []];
  const logicalRequestRef = prepared.requestRef;
  for (;;) {
    signal.throwIfAborted();
    const started = store.events(run.id, { types: ['model.started'], match: { logicalRequestRef } });
    const retry = store.latestEvent(run.id, { types: ['model.retry'], match: { requestRef: logicalRequestRef } });
    const latest = started.at(-1);
    // A durable transition authorizes the next physical request. Recovery never
    // silently repeats an endpoint with an unknown or already rejected outcome.
    if (latest && (!retry || retry.seq < latest.seq)) throw new KodoError('MODEL_RETRIES', 'the previous provider attempt has no approved retry transition; inspect before continuing');
    const routeIndex = Number(retry?.data.nextRouteIndex ?? 0);
    const route = routes[routeIndex];
    if (!Number.isInteger(routeIndex) || !route) throw new KodoError('MODEL_RETRIES', 'configured provider alternatives are exhausted; inspect before continuing');
    const request = { ...prepared.request, binding: route };
    const physical: Prepared = { ...prepared, request, requestRef: store.blob(request) };
    const identity = (index: number): string => routes[index]?.provider ?? (index === 0 ? 'primary' : `fallback-${index}`);
    const changed = routeIndex > 0 && latest?.data.routeIndex !== routeIndex && retry?.data.reason === 'provider_failover';
    const modelCall = startAttempt(host, run, physical, reserve, started.length, signal, {
      logicalRequestRef, routeIndex,
      ...(changed ? { change: { from: identity(routeIndex - 1), to: identity(routeIndex), model: route.model, reason: String(retry.data.providerFailure) } } : {}),
    });
    let emitted = false;
    let response: ModelResponse;
    try {
      response = await host.provider.complete(store.readBlob(physical.requestRef), signal, text => { if (text) emitted = true; host.onText(run.id, text); });
      signal.throwIfAborted();
      const repair = repairResponse(response, toolSpecs(host, run, store.session(run.sessionId)).map(spec => spec.name), request.toolChoice === 'none');
      if (repair.renamed.length || repair.droppedToolCalls) store.event(run.id, 'model.response_repaired', { callId: modelCall.id, renamed: repair.renamed, droppedToolCalls: repair.droppedToolCalls });
      response = repair.response;
      if (!validResponse(request, response)) throw new KodoError('MODEL_PROTOCOL', 'invalid completed response');
    } catch (error) {
      recordFailure(host, run, modelCall, error, signal);
      if (signal.aborted) throw signal.reason;
      if (error instanceof KodoError && error.code === 'MODEL_CONTEXT') return { overflow: 'MODEL_CONTEXT', reason: error.message };
      const guided = store.hasEvent(run.id, { types: ['model.output_guided'], match: { step: run.step } });
      const outputLimit = outputLimitRetry(host, run, prepared, error);
      const incompleteStream = incompleteStreamRetry(host, run, prepared, error, emitted);
      if (error instanceof KodoError && error.metadata?.outputLimit && (guided || !outputLimit)) return { outputLimit: errorText(error) };
      const eligible = error instanceof KodoError && !emitted && !error.metadata?.usage && !error.metadata?.partialResponse && !error.metadata?.outputLimit
        && (['MODEL_AUTH', 'MODEL_CREDENTIAL', 'MODEL_QUOTA', 'MODEL_RATE_LIMIT', 'MODEL_TRANSPORT'].includes(error.code) || error.code === 'MODEL_REQUEST' && error.metadata?.status === 404);
      const nextRouteIndex = eligible ? routeIndex + 1 : routeIndex;
      if ((!eligible && !outputLimit && !incompleteStream) || nextRouteIndex >= routes.length) return { kind: 'fail', error: errorText(error) };
      store.event(run.id, 'model.retry', {
        requestRef: logicalRequestRef, previousCallId: modelCall.id, nextAttempt: started.length + 2, delayMs: 0,
        reason: eligible ? 'provider_failover' : outputLimit ? 'output_limit' : 'incomplete_stream', nextRouteIndex,
        ...(eligible && error instanceof KodoError ? { providerFailure: error.code } : {}),
      });
      lease.release?.(); lease.release = undefined;
      lease.release = await host.acquireModel(run, signal);
      continue;
    }
    recordSuccess(host, run, modelCall, response);
    return 'done';
  }
}

/** One immutable snapshot: three transient attempts, plus one retry each for truncation and an unterminated stream. */
async function callModel(host: StepHost, run: Run, prepared: Prepared, reserve: number, lease: Lease, signal: AbortSignal): Promise<'done' | Overflow | OutputLimit | StepOutcome> {
  if (prepared.request.binding.fallbacks?.length) return await callProviderGroup(host, run, prepared, reserve, lease, signal);
  const { store } = host;
  for (;;) {
    const attempts = store.countCalls(run.id, { kind: 'model', requestRef: prepared.requestRef });
    const outputRetries = store.countEvents(run.id, { types: ['model.retry'], match: { reason: 'output_limit', requestRef: prepared.requestRef } });
    const incompleteRetries = store.countEvents(run.id, { types: ['model.retry'], match: { reason: 'incomplete_stream', requestRef: prepared.requestRef } });
    const incompleteFailure = store.latestEvent(run.id, { types: ['model.failed'], match: { incompleteStream: true, requestRef: prepared.requestRef } });
    // Restart must not create another attempt after a terminal incomplete failure.
    if (incompleteFailure && !store.hasEvent(run.id, { types: ['model.retry'], match: { previousCallId: String(incompleteFailure.data.callId) } })) return { kind: 'fail', error: String(incompleteFailure.data.error) };
    if (incompleteRetries) {
      const started = store.latestEvent(run.id, { types: ['model.started'], match: { requestRef: prepared.requestRef } });
      const retry = store.latestEvent(run.id, { types: ['model.retry'], match: { requestRef: prepared.requestRef } });
      // A crash after starting the retry consumes it too, even before failure is recorded.
      if (started && (!retry || retry.seq < started.seq)) throw new KodoError('MODEL_RETRIES', 'the previous incomplete-stream retry has no new retry transition; inspect before continuing');
    }
    if (attempts >= 3 + outputRetries + incompleteRetries) throw new KodoError('MODEL_RETRIES', 'transient attempts of the same request exhausted; inspect before continuing');
    const modelCall = startAttempt(host, run, prepared, reserve, attempts, signal);
    let emitted = false;
    let response: ModelResponse;
    try {
      response = await host.provider.complete(store.readBlob(prepared.requestRef), signal, text => { if (text) emitted = true; host.onText(run.id, text); });
      signal.throwIfAborted();
      const repair = repairResponse(response, toolSpecs(host, run, store.session(run.sessionId)).map(spec => spec.name), prepared.request.toolChoice === 'none');
      if (repair.renamed.length || repair.droppedToolCalls) store.event(run.id, 'model.response_repaired', { callId: modelCall.id, renamed: repair.renamed, droppedToolCalls: repair.droppedToolCalls });
      response = repair.response;
      if (!validResponse(prepared.request, response)) throw new KodoError('MODEL_PROTOCOL', 'invalid completed response');
    } catch (error) {
      recordFailure(host, run, modelCall, error, signal);
      if (signal.aborted) throw signal.reason;
      if (error instanceof KodoError && error.code === 'MODEL_CONTEXT') return { overflow: 'MODEL_CONTEXT', reason: error.message };
      const guided = store.hasEvent(run.id, { types: ['model.output_guided'], match: { step: run.step } });
      if (error instanceof KodoError && error.metadata?.outputLimit && (guided || !outputLimitRetry(host, run, prepared, error))) return { outputLimit: errorText(error) };
      const outputLimit = outputLimitRetry(host, run, prepared, error);
      const incompleteStream = incompleteStreamRetry(host, run, prepared, error, emitted);
      if (!(error instanceof KodoError) || (!outputLimit && !incompleteStream && (!['MODEL_RATE_LIMIT', 'MODEL_TRANSPORT'].includes(error.code) || attempts - outputRetries - incompleteRetries >= 2))) return { kind: 'fail', error: errorText(error) };
      const transientAttempt = error.code === 'MODEL_TRANSPORT' ? attempts - outputRetries - incompleteRetries : undefined;
      const delayMs = outputLimit || incompleteStream ? 0 : transientAttempt !== undefined ? transportBackoffMs(transientAttempt, error.metadata?.retryAfterMs) : Math.min(60_000, Math.max(0, error.metadata?.retryAfterMs ?? Math.ceil(1000 * 2 ** attempts * (1 + Math.random() * 0.25))));
      store.event(run.id, 'model.retry', { requestRef: prepared.requestRef, previousCallId: modelCall.id, nextAttempt: attempts + 2, delayMs, ...(outputLimit ? { reason: 'output_limit' } : incompleteStream ? { reason: 'incomplete_stream' } : {}) });
      lease.release?.();
      lease.release = undefined;
      const waitCeiling = retryWaitCeiling();
      await delay(waitCeiling === undefined ? delayMs : Math.min(delayMs, waitCeiling), undefined, { signal });
      lease.release = await host.acquireModel(run, signal);
      continue;
    }
    recordSuccess(host, run, modelCall, response);
    return 'done';
  }
}

/**
 * Persists the model response of the current step, or returns a terminal outcome.
 * A context overflow (pre-request estimate or provider MODEL_CONTEXT) forces one
 * compaction and retries once per step; a second overflow stops with a handoff report.
 */
export async function runModelStep(host: StepHost, runId: string, signal: AbortSignal): Promise<StepOutcome | undefined> {
  const { store } = host;
  const initial = store.run(runId);
  if (initial.stepCallId && store.call(initial.stepCallId).status === 'succeeded') return undefined;
  const lease: Lease = { release: await host.acquireModel(initial, signal) };
  try {
    let forced = store.hasEvent(runId, { types: ['context.overflow_recovery'], match: { step: initial.step } });
    let next: Prepared | undefined;
    const guided = !initial.stepCallId && !forced ? store.latestEvent(runId, { types: ['model.output_guided'], match: { step: initial.step } }) : undefined;
    if (guided && typeof guided.data.requestRef === 'string') next = { request: store.readBlob<Request>(guided.data.requestRef), requestRef: guided.data.requestRef, version: initial.decisionVersion };
    for (;;) {
      let run = store.run(runId);
      let prepared: Prepared | Overflow;
      if (next) { prepared = next; next = undefined; }
      else if (run.stepCallId) {
        const original = store.call(run.stepCallId);
        const requestRef = original.logicalRequestRef ?? original.requestRef;
        prepared = { requestRef, request: store.readBlob<Request>(requestRef), version: original.decisionVersion };
      } else {
        try { prepared = await buildRequest(host, runId, signal, forced); }
        catch (error) {
          if (error instanceof RequiredInputOverflow) return handoffFailure(store, run, error.code, error.message);
          throw error;
        }
      }
      run = store.run(runId);
      let outcome: 'done' | Overflow | OutputLimit | StepOutcome = 'overflow' in prepared ? prepared : { overflow: 'CONTEXT_LIMIT', reason: 'estimated input plus output reservation exceeds the model token window' };
      if (!('overflow' in prepared)) {
        // Every attempt has its own Call and reservation, but reuses the immutable request snapshot.
        const reserve = estimateInputTokens(store, run, prepared.request.messages, prepared.request.tools) + prepared.request.maxOutputTokens;
        if (reserve <= runBudget(run, store.session(run.sessionId)).maxContextTokens) outcome = await callModel(host, run, prepared, reserve, lease, signal);
      }
      if (outcome === 'done') return undefined;
      if ('outputLimit' in outcome && !('overflow' in prepared)) {
        if (store.hasEvent(run.id, { types: ['model.output_guided'], match: { step: run.step } })) return handoffFailure(store, run, 'MODEL_OUTPUT_LIMIT', `${outcome.outputLimit}; output was still truncated after one unchanged retry and one guided request`);
        const notice = attachment('notice', `The previous response was truncated at the output limit of ${prepared.request.maxOutputTokens} tokens (reasoning and answer share this limit). Split this step: use fewer tool calls, make smaller edits, and keep the response concise. Continue from recorded results; the truncated response did not execute any tool calls.`);
        const messages = [...prepared.request.messages];
        messages.splice(Math.max(0, messages.length - 1), 0, notice);
        // Output-limit recovery stays on the endpoint that produced the limit,
        // including when an earlier endpoint in its group was unavailable.
        const currentCall = store.run(run.id).stepCallId;
        const binding = prepared.request.binding.fallbacks?.length && currentCall
          ? store.readBlob<Request>(store.call(currentCall).requestRef).binding : prepared.request.binding;
        const request = { ...prepared.request, binding, messages };
        const session = store.session(run.sessionId);
        const budget = runBudget(run, session);
        const guidedInput = estimateInputTokens(store, run, messages, request.tools);
        if (guidedInput + request.maxOutputTokens > budget.maxContextTokens || guidedInput > (run.modelLimits?.input ?? session.modelLimits?.input ?? Infinity) || (budget.maxContextChars !== null && JSON.stringify({ messages, tools: request.tools }).length > budget.maxContextChars)) return handoffFailure(store, run, 'MODEL_OUTPUT_LIMIT', 'the guided retry cannot fit beside the output allowance; output truncation does not trigger compaction');
        const requestRef = store.blob(request);
        store.transaction(() => {
          const current = store.run(run.id);
          store.updateRun(run.id, { stepCallId: undefined, contextRef: store.blob([...store.readBlob<Message[]>(current.contextRef), notice]) });
          store.event(run.id, 'model.output_guided', { step: run.step, originalRequestRef: prepared.requestRef, requestRef, maxOutputTokens: request.maxOutputTokens });
        });
        next = { request, requestRef, version: prepared.version };
        continue;
      }
      if ('outputLimit' in outcome) return handoffFailure(store, run, 'MODEL_OUTPUT_LIMIT', outcome.outputLimit);
      if (!('overflow' in outcome)) return outcome;
      if (forced) return handoffFailure(store, run, outcome.overflow, `${outcome.reason}; the request still overflows after forced compaction`);
      store.transaction(() => {
        store.updateRun(runId, { stepCallId: undefined });
        store.event(runId, 'context.overflow_recovery', { code: outcome.overflow, reason: outcome.reason, step: run.step });
      });
      forced = true;
    }
  } finally { lease.release?.(); }
}
