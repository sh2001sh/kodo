import { randomUUID } from 'node:crypto';
import { Store, digest } from '../storage/index.js';
import { createInputTokenEstimator, estimateInputTokens } from './context-tokens.js';
import { recoveryHistoryRuns } from './history.js';
import { contextOutputReserve } from '../providers/model-limits.js';
import { buildContext, messageGroups } from './context.js';
import { errorText, KodoError, terminal } from './types.js';
import type { ContextBuild, HistorySnapshot } from './context.js';
import type { Budget, Call, Message, ModelResponse, Provider, Run, ToolSpec } from './types.js';
import { compactionInstruction } from './summary-schema.js';
import { chargedTokens, failureSettlement } from './usage.js';
import { installSummary } from './summary-install.js';
import type { HostHooks } from './hooks.js';
import { attachment } from './attachments.js';
import { recordMethodUnloading } from './method-context.js';

export type { SummaryEnvelope, SummaryEnvelopeV1, SummaryEnvelopeV2, SummarySource } from './summary-schema.js';

export interface SummaryInput { store: Store; run: Run; built: ContextBuild; budget: Budget; tools: ToolSpec[]; provider: Provider; signal: AbortSignal; hooks?: HostHooks }
export interface SummaryJob {
  input: SummaryInput; plan: NonNullable<ContextBuild['summaryPlan']>; archive: HistorySnapshot;
  baselineRef: string; decisionVersion: number; attemptKey: string; outputTokens: number;
  previousSummaryRef?: string; priorMarker?: string;
  beforeNotes?: string[];
}
export interface SummaryResult { text: string; usage: ModelResponse['usage'] | null; droppedGroups: number }

type Request = Parameters<Provider['complete']>[0];
type Outcome = { ok: true; text: string; usage: ModelResponse['usage'] | null } | { ok: false; skipped?: boolean; reason: string };
interface History { messages: Message[]; dropped: number }

const retryable = (reason: string): boolean => /^(MODEL_INCOMPLETE|MODEL_TRANSPORT|MODEL_RATE_LIMIT|SUMMARY_MESSAGE):/.test(reason);

/**
 * Replace folded history with one free-text handoff summary. The request is the
 * unchanged main-request prefix plus a compaction instruction, with the same tools
 * and toolChoice 'none', so providers can reuse the prompt cache. Any non-empty
 * text may install; failures leave the mask projection in place.
 */
export async function summarizeContext(input: SummaryInput): Promise<boolean> {
  const { built } = input;
  if (!built.summaryPlan) return false;
  const job = prepareJob(input);
  if (!job) return false;
  const before = await input.hooks?.run('compaction.before', { runId: input.run.id, data: { archivedRef: job.plan.archivedRef, targetTokens: job.plan.targetTokens } }, input.signal);
  if (before?.notes.length) job.beforeNotes = before.notes;
  const result = await generate(job);
  const installed = result ? await installSummary(job, result) : false;
  const after = await input.hooks?.run('compaction.after', { runId: input.run.id, data: { archivedRef: job.plan.archivedRef, installed } }, input.signal);
  const notes = [...(!installed ? before?.notes ?? [] : []), ...(after?.notes ?? [])];
  if (notes.length) preserveHookNotes(input, notes);
  return installed;
}

/** Hook context is durable and subject to the normal hard capacity, never an unbudgeted suffix. */
function preserveHookNotes(input: SummaryInput, notes: string[]): void {
  const { store, budget, tools } = input;
  store.transaction(() => {
    input.signal.throwIfAborted();
    const current = store.run(input.run.id);
    if (terminal(current.status) || current.status === 'interrupted') return;
    const messages = [...store.readBlob<Message[]>(current.contextRef), attachment('compaction', JSON.stringify({ hookNotes: notes }))];
    const built = buildContext(store, { ...current, contextRef: store.blob(messages) }, budget.maxContextChars, tools, {
      maxContextTokens: budget.maxContextTokens, maxOutputTokens: contextOutputReserve(budget),
      maxInputTokens: current.modelLimits?.input ?? store.session(current.sessionId).modelLimits?.input,
    });
    store.updateRun(current.id, { contextRef: store.blob(built.messages) });
    recordMethodUnloading(store, current.id, built.methodUnloading);
    if (built.archivedRef) store.event(current.id, 'context.compacted', { archivedRef: built.archivedRef, strategy: built.strategy, afterTokens: built.estimatedInputTokens });
  });
}

/** Record a skipped summary once per consecutive reason, e.g. reason=geometry from buildContext. */
export function recordSkip(store: Store, runId: string, data: Record<string, unknown>): void {
  const last = store.latestEvent(runId, { typePrefix: 'context.summary.' });
  if (last?.type === 'context.summary.skipped' && last.data.reason === data.reason) return;
  store.event(runId, 'context.summary.skipped', data);
}

function previousSummary(store: Store, run: Run): { ref?: string; marker?: string } {
  const prior = recoveryHistoryRuns(store, run).flatMap(owner => store.events(owner.id, { types: ['context.summary.installed'] })).sort((a, b) => a.seq - b.seq).findLast(event => typeof event.data.summaryRef === 'string');
  return { ref: prior?.data.summaryRef as string | undefined, marker: prior?.data.marker as string | undefined };
}

function prepareJob(input: SummaryInput): SummaryJob | undefined {
  const { store, run, built, budget } = input;
  const plan = built.summaryPlan!;
  const archive = store.readBlob<HistorySnapshot>(plan.archivedRef);
  const previous = previousSummary(store, run);
  const decisionVersion = store.session(run.sessionId).decisionVersion ?? 0;
  // One attempt per folded source version: a failed or interrupted attempt is never regenerated.
  const attemptKey = digest(JSON.stringify([plan.foldOffsets.map(offset => archive.messages[offset]), previous.ref ?? null, run.binding, decisionVersion]));
  if (recoveryHistoryRuns(store, run).some(owner => store.hasEvent(owner.id, { types: ['context.summary.started'], match: { attemptKey } }))) return;
  if (!store.hasEvent(run.id, { types: ['context.compacted', 'context.archived', 'context.summary.started'], match: { archivedRef: plan.archivedRef } })) store.event(run.id, 'context.archived', { archivedRef: plan.archivedRef });
  return {
    input, plan, archive, baselineRef: run.contextRef, decisionVersion, attemptKey,
    outputTokens: Math.min(budget.maxOutputTokens, contextOutputReserve(budget)),
    ...(previous.ref ? { previousSummaryRef: previous.ref } : {}), ...(previous.marker ? { priorMarker: previous.marker } : {}),
  };
}

/** Remove the oldest assistant round; system and user messages are never dropped from the request. */
function dropOldest(history: History): History | undefined {
  const groups = messageGroups(history.messages);
  const index = groups.findIndex(group => group[0]!.role === 'assistant');
  if (index < 0) return;
  return { messages: groups.filter((_, position) => position !== index).flat(), dropped: history.dropped + 1 };
}

function fitWindow(job: SummaryJob, history: History | undefined, instruction: Message): History | undefined {
  const { store, run, budget, tools } = job.input;
  const session = store.session(run.sessionId);
  const estimator = createInputTokenEstimator(store, run, tools);
  const limit = Math.min(run.modelLimits?.input ?? session.modelLimits?.input ?? Infinity, budget.maxContextTokens - job.outputTokens);
  const fits = (messages: Message[]): boolean => estimator.estimate(messages) <= limit && (budget.maxContextChars === null || estimator.size(messages) <= budget.maxContextChars);
  let current = history;
  while (current && !fits([...current.messages, instruction])) current = dropOldest(current);
  return current;
}

async function generate(job: SummaryJob): Promise<SummaryResult | undefined> {
  const { store, run, built, tools } = job.input;
  const instruction: Message = { role: 'user', content: compactionInstruction(job.plan.targetTokens) + (job.beforeNotes?.length ? `\nAdditional host context to preserve as data: ${JSON.stringify(job.beforeNotes)}` : '') };
  let history = fitWindow(job, { messages: built.messages, dropped: 0 }, instruction);
  let attempts = 0;
  let transientRetried = false;
  let windowRecovered = false;
  const fail = (reason: string): undefined => { store.event(run.id, 'context.summary.failed', { attemptKey: job.attemptKey, reason, attempts }); return undefined; };
  for (;;) {
    if (!history) return attempts ? fail('SUMMARY_WINDOW: no droppable round is left for the summary request') : (recordSkip(store, run.id, { reason: 'window', attemptKey: job.attemptKey }), undefined);
    const request: Request = { binding: run.binding, messages: [...history.messages, instruction], tools, toolChoice: 'none', maxOutputTokens: job.outputTokens, ...(run.binding.promptCache === 'session' ? { cacheKey: run.sessionId } : {}) };
    const outcome = await requestSummary(job, request, attempts++);
    if (outcome.ok) return { text: outcome.text, usage: outcome.usage, droppedGroups: history.dropped };
    if (outcome.skipped) return attempts > 1 ? fail(outcome.reason) : undefined;
    if (outcome.reason.startsWith('MODEL_CONTEXT:') && !windowRecovered) {
      windowRecovered = true;
      // One forced projection, using the same install target as normal compaction.
      // A second provider overflow fails this summary only; the run keeps its mask.
      const estimate = createInputTokenEstimator(store, run, tools).estimate;
      do { history = dropOldest(history); }
      while (history && estimate([...history.messages, instruction]) > built.geometry!.targetTokens);
      history = fitWindow(job, history, instruction);
      continue;
    }
    if (retryable(outcome.reason) && !transientRetried) { transientRetried = true; continue; }
    return fail(outcome.reason);
  }
}

/** Reserve spending for one summary call; explicit host caps keep room for the normal response that follows. */
function reserve(job: SummaryJob, request: Request, attempt: number): Call | Outcome {
  const { store, run, built, budget, signal } = job.input;
  const session = store.session(run.sessionId);
  const reservedTokens = estimateInputTokens(store, run, request.messages, request.tools) + job.outputTokens;
  const normalReserve = built.estimatedInputTokens + contextOutputReserve(budget);
  const requiredCalls = 2 + Number(Boolean(run.parentId));
  if ((session.budget.maxModelCalls !== null && session.modelCalls + requiredCalls > session.budget.maxModelCalls) || (session.budget.maxTokens !== null && session.tokens + reservedTokens + normalReserve > session.budget.maxTokens)) {
    const reason = 'shared budget preserves normal response';
    if (!attempt) recordSkip(store, run.id, { reason, attemptKey: job.attemptKey });
    return { ok: false, skipped: true, reason: `SUMMARY_SKIPPED: ${reason}` };
  }
  const requestRef = store.blob(request);
  const call: Call = { id: randomUUID(), runId: run.id, step: run.step, kind: 'model', name: run.binding.model, purpose: 'compaction', effect: 'read', status: 'running', requestRef, reservedTokens, decisionVersion: job.decisionVersion };
  store.transaction(() => {
    signal.throwIfAborted();
    const latest = store.session(session.id);
    const current = store.run(run.id);
    if (terminal(current.status) || current.status === 'interrupted' || current.cancelRequested || current.contextRef !== job.baselineRef || (latest.decisionVersion ?? 0) !== job.decisionVersion) throw new KodoError('RECOVERY_REQUIRED', 'summary lost execution authority before reservation');
    store.putSession({ ...latest, modelCalls: latest.modelCalls + 1, tokens: latest.tokens + reservedTokens });
    store.putCall(call);
    if (!attempt) store.event(run.id, 'context.summary.started', { callId: call.id, attemptKey: job.attemptKey, archivedRef: job.plan.archivedRef, coveredOffsets: job.plan.foldOffsets, coverageHash: digest(JSON.stringify(job.plan.foldOffsets.map(offset => job.archive.messages[offset]))), previousSummaryRef: job.previousSummaryRef, requestRef, beforeTokens: built.estimatedInputTokens, targetTokens: job.plan.targetTokens, outputTokens: job.outputTokens });
    store.event(run.id, 'model.started', { callId: call.id, requestRef, purpose: 'compaction', reservedTokens, ...(attempt ? { retry: true } : {}) });
  });
  return call;
}

async function complete(job: SummaryJob, request: Request, estimatedInput: number): Promise<ModelResponse> {
  const { provider, signal } = job.input;
  // Large prefixes need proportionally more time; the bound keeps a stuck stream from blocking the run.
  const combined = AbortSignal.any([signal, AbortSignal.timeout(Math.min(300_000, 60_000 + Math.ceil(estimatedInput / 1000) * 1000))]);
  let abort: () => void = () => {};
  try {
    const cancelled = new Promise<never>((_, reject) => { abort = () => reject(combined.reason); combined.addEventListener('abort', abort, { once: true }); if (combined.aborted) abort(); });
    const response = await Promise.race([provider.complete(request, combined, () => {}), cancelled]);
    const usage = response.usage;
    if (usage && ([usage.input, usage.output, usage.cacheRead ?? 0, usage.cacheWrite ?? 0].some(value => !Number.isSafeInteger(value) || value < 0) || (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) > usage.input)) throw new KodoError('SUMMARY_USAGE', 'invalid usage counters');
    return response;
  } finally { combined.removeEventListener('abort', abort); }
}

/** One accounted model call. Only protocol failures and empty text are rejected; length and format are not. */
async function requestSummary(job: SummaryJob, request: Request, attempt: number): Promise<Outcome> {
  const { store, run, signal } = job.input;
  const reserved = reserve(job, request, attempt);
  if (!('id' in reserved)) return reserved;
  const call = reserved;
  let response: ModelResponse;
  try { response = await complete(job, request, call.reservedTokens! - job.outputTokens); }
  catch (error) {
    store.transaction(() => {
      const latest = store.session(run.sessionId);
      const settlement = failureSettlement(error, call.reservedTokens!, latest.budget);
      store.putSession({ ...latest, tokens: latest.tokens - call.reservedTokens! + settlement.settledTokens, usageEstimated: latest.usageEstimated || settlement.estimated });
      store.putCall({ ...call, status: signal.aborted ? 'cancelled' : 'failed', resultRef: store.blob({ error: errorText(error), usage: settlement.usage }) });
      store.event(run.id, 'model.failed', { callId: call.id, purpose: 'compaction', error: errorText(error), usageKnownZero: settlement.knownZero, usage: typeof settlement.usage === 'object' ? settlement.usage : null });
    });
    signal.throwIfAborted();
    return { ok: false, reason: errorText(error) };
  }
  store.transaction(() => {
    const latest = store.session(run.sessionId);
    store.putSession({ ...latest, tokens: latest.tokens - call.reservedTokens! + (response.usage ? chargedTokens(response.usage, latest.budget) : call.reservedTokens!), usageEstimated: latest.usageEstimated || !response.usage });
    store.putCall({ ...call, status: 'succeeded', resultRef: store.blob(response) });
    store.event(run.id, 'model.finished', { callId: call.id, purpose: 'compaction', usage: response.usage ?? null, estimated: !response.usage });
  });
  if (response.finishReason !== 'stop' || response.message.role !== 'assistant' || response.message.tool_calls?.length) return { ok: false, reason: 'SUMMARY_MESSAGE: summary returned tool calls or an incomplete message' };
  const text = response.message.content?.trim() ?? '';
  if (!text) return { ok: false, reason: 'SUMMARY_EMPTY: summary text is empty' };
  return { ok: true, text, usage: response.usage ?? null };
}
