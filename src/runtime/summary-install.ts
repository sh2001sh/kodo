import { digest } from '../storage/index.js';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { buildContext, rebuildSummaryPrefix } from './context.js';
import { geometryShares } from './compaction-trigger.js';
import { contextOutputReserve } from '../providers/model-limits.js';
import { errorText, KodoError, terminal } from './types.js';
import { summaryMarker } from './summary-schema.js';
import { deliveryState, renderDeliveryState } from './delivery-state.js';
import type { Message } from './types.js';
import type { HistorySnapshot } from './context.js';
import type { SummaryJob, SummaryResult } from './compaction.js';
import type { SummaryEnvelopeV2 } from './summary-schema.js';
import { attachment, attachmentKind, attachmentKinds, escapeMarkers } from './attachments.js';
import { createInputTokenEstimator, estimateTextTokens } from './context-tokens.js';
import { canAccessFileScope } from './scope.js';
import { rememberSummary } from './memory.js';
import { recordInstructions } from './instruction-layer.js';

interface RestoredFile { path: string; tokens: number; complete: boolean; status: 'restored' | 'budget' | 'changed' | 'unavailable'; excerpt?: string }
interface Restoration { messages: Message[]; files: RestoredFile[]; budget: number; usedTokens: number; afterTokens: number }

/** Kernel and lean model tool names whose `path` (and `destination`) name a workspace file. */
const foldedFileTools = new Set(['file.read', 'file.patch', 'file.apply_patch', 'file.rename', 'read', 'edit', 'write', 'move']);

/** Only native file paths present in the folded history are candidates for fresh excerpts. */
function foldedFiles(job: SummaryJob): string[] {
  const files: string[] = [];
  for (const offset of job.plan.foldOffsets) {
    const message = job.archive.messages[offset];
    if (message?.role !== 'assistant') continue;
    for (const call of message.tool_calls ?? []) {
      if (!foldedFileTools.has(call.name)) continue;
      try {
        const input = JSON.parse(call.arguments) as { path?: unknown; destination?: unknown };
        for (const value of [input.path, input.destination]) if (typeof value === 'string') files.push(value);
      } catch { /* A malformed historical call has no file to restore. */ }
    }
  }
  return [...new Set(files)].reverse();
}

/** Stream a file to verify its entire hash while keeping only a budget-sized prefix in memory. */
async function verifiedExcerpt(file: string, expectedHash: string, maxBytes: number, signal: AbortSignal): Promise<{ text: string; complete: boolean } | undefined> {
  const before = await stat(file);
  if (!before.isFile()) return undefined;
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  let retained = 0;
  for await (const data of createReadStream(file, { signal, highWaterMark: 64 * 1024 })) {
    const chunk = Buffer.from(data as Uint8Array);
    hash.update(chunk);
    if (retained < maxBytes) {
      const part = chunk.subarray(0, maxBytes - retained);
      chunks.push(part); retained += part.length;
    }
  }
  const after = await stat(file);
  if (hash.digest('hex') !== expectedHash || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return undefined;
  return { text: Buffer.concat(chunks).toString('utf8').replace(/�$/, ''), complete: retained === after.size };
}

/** All restoration, including its metadata, fits the same install target and hard capacity. */
async function restoreFiles(job: SummaryJob, messages: Message[], installTarget: number): Promise<Restoration> {
  const { store, run, tools, budget, signal } = job.input;
  const session = store.session(run.sessionId);
  const estimator = createInputTokenEstimator(store, run, tools);
  const beforeTokens = estimator.estimate(messages);
  const capacity = Math.min(installTarget, budget.maxContextTokens - contextOutputReserve(budget), run.modelLimits?.input ?? session.modelLimits?.input ?? Infinity);
  const room = Math.max(0, capacity - beforeTokens);
  const files: RestoredFile[] = [];
  if (!session.permissions.includes('read') || !(run.permissions ?? session.permissions).includes('read')) return { messages, files, budget: room, usedTokens: 0, afterTokens: beforeTokens };
  const body = (): string => JSON.stringify({ archivedRef: job.plan.archivedRef, note: 'Folded history remains available through history.read. Excerpts below match this run’s last observed file hash; paths without excerpts require a fresh read.', files });
  const fits = (candidate: Message[]): boolean => estimator.estimate(candidate) <= capacity && (budget.maxContextChars === null || estimator.size(candidate) <= budget.maxContextChars);
  let output = messages;
  for (const relative of foldedFiles(job)) {
    signal.throwIfAborted();
    const file = path.resolve(session.workspace, relative);
    if (!canAccessFileScope(run.scope, 'read', session.workspace, file)) continue;
    const observed = store.fileStates.get(run.id, file);
    if (!observed) continue;
    const item: RestoredFile = { path: path.relative(session.workspace, file).replaceAll('\\', '/'), tokens: 0, complete: false, status: 'budget' };
    files.push(item);
    const notice = (): Message[] => [...messages, attachment('compaction', body())];
    const fitsNotice = (): boolean => escapeMarkers(body()).length <= attachmentKinds.compaction.maxChars && fits(notice());
    if (!fitsNotice()) {
      files.pop();
      // The event still identifies omitted paths without exceeding the model input budget.
      break;
    }
    if (!room) { output = notice(); continue; }
    try {
      const excerpt = await verifiedExcerpt(file, observed.hash, Math.ceil(room * 4), signal);
      if (!excerpt) item.status = 'changed';
      else {
        item.status = 'restored'; item.excerpt = excerpt.text; item.complete = excerpt.complete;
        // Token estimates include JSON escaping, attachment framing and all earlier excerpts.
        let low = 0; let high = excerpt.text.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          item.excerpt = excerpt.text.slice(0, middle);
          if (fitsNotice()) low = middle; else high = middle - 1;
        }
        item.excerpt = excerpt.text.slice(0, low).replace(/[\uD800-\uDBFF]$/, '');
        item.complete = excerpt.complete && low === excerpt.text.length;
        if (!item.excerpt) { delete item.excerpt; item.status = 'budget'; }
        item.tokens = estimateTextTokens(item.excerpt ?? '');
        // Updating the recorded token number adds digits; leave those inside the same budget.
        while (!fitsNotice() && item.excerpt?.length) { item.excerpt = item.excerpt.slice(0, -16); item.complete = false; item.tokens = estimateTextTokens(item.excerpt); }
        if (!item.excerpt && item.status === 'restored') { delete item.excerpt; item.status = 'budget'; item.tokens = 0; }
      }
    } catch (error) {
      signal.throwIfAborted();
      if (!['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      item.status = 'unavailable';
    }
    if (fitsNotice()) output = notice();
    else files.pop();
  }
  const afterTokens = estimator.estimate(output);
  return { messages: output, files, budget: room, usedTokens: afterTokens - beforeTokens, afterTokens };
}

/**
 * Covered history leaves the working context; the single marker takes the place
 * of the first covered message and replaces any previous marker.
 */
function candidate(job: SummaryJob, marker: string): Message[] {
  const covered = new Set(job.plan.foldOffsets);
  const first = job.plan.foldOffsets[0];
  const messages: Message[] = [];
  job.archive.messages.forEach((message, index) => {
    if (index === first) messages.push({ role: 'user', content: marker });
    if (covered.has(index) || attachmentKind(message) === 'compaction' || (job.priorMarker && message.role === 'user' && message.content === job.priorMarker)) return;
    messages.push(message);
  });
  if (job.beforeNotes?.length) messages.push(attachment('compaction', JSON.stringify({ hook: 'compaction.before', notes: job.beforeNotes })));
  return messages;
}

/**
 * Atomically install a generated summary, or record why not. Only an empty
 * summary (rejected earlier) or no input reduction (SUMMARY_NO_GAIN) refuse a
 * candidate; length and format are never rejection reasons.
 */
export async function installSummary(job: SummaryJob, result: SummaryResult): Promise<boolean> {
  const { store, run, built, budget, tools, signal } = job.input;
  const session = store.session(run.sessionId);
  const { archivedRef, foldOffsets } = job.plan;
  const geometry = built.geometry!;
  // The rebuild masks with the same trigger geometry, never with a summary of its own.
  const maskPolicy = geometry.mode === 'work' ? { strategy: 'mask' as const, workInputTokens: geometry.triggerTokens } : { strategy: 'mask' as const, triggerRatio: geometry.triggerRatio };
  const contextOptions = {
    maxContextTokens: budget.maxContextTokens,
    maxOutputTokens: contextOutputReserve(budget),
    maxInputTokens: run.modelLimits?.input ?? session.modelLimits?.input,
    compaction: maskPolicy,
  };
  const coverageHash = digest(JSON.stringify(foldOffsets.map(index => job.archive.messages[index])));
  try {
    const state = run.parentId ? undefined : renderDeliveryState(deliveryState(store, store.run(run.id)));
    const marker = summaryMarker({ text: result.text, archivedRef, coveredOffsets: foldOffsets, droppedGroups: result.droppedGroups, ...(state ? { deliveryState: state } : {}), ...(session.toolProfile ? { profile: session.toolProfile } : {}) });
    const prefix = rebuildSummaryPrefix(store, run, candidate(job, marker));
    const rebuilt = buildContext(store, { ...run, contextRef: store.blob(prefix.messages) }, budget.maxContextChars, tools, contextOptions);
    if (rebuilt.estimatedInputTokens >= built.estimatedInputTokens) throw new KodoError('SUMMARY_NO_GAIN', 'candidate does not reduce working context');
    const targetTokens = geometry.targetTokens;
    const { installTokens: installTargetTokens } = geometryShares(geometry, job.plan.fixedTokens);
    const restoration = await restoreFiles(job, rebuilt.messages, installTargetTokens);
    const envelope: SummaryEnvelopeV2 = {
      version: 2, archivedRef, coveredOffsets: foldOffsets, coverageHash, text: result.text, usage: result.usage,
      decisionVersion: job.decisionVersion, binding: run.binding, beforeTokens: built.estimatedInputTokens, afterTokens: restoration.afterTokens,
      targetTokens: job.plan.targetTokens, droppedGroups: result.droppedGroups,
      ...(job.previousSummaryRef ? { previousSummaryRef: job.previousSummaryRef } : {}),
    };
    const summaryRef = store.blob(envelope);
    return store.transaction(() => {
      const latest = store.run(run.id);
      const frozen = store.readBlob<HistorySnapshot>(archivedRef);
      if (signal.aborted || terminal(latest.status) || latest.status === 'interrupted' || latest.cancelRequested || latest.contextRef !== job.baselineRef || (store.session(session.id).decisionVersion ?? 0) !== job.decisionVersion || digest(JSON.stringify(foldOffsets.map(index => frozen.messages[index]))) !== coverageHash) {
        store.event(run.id, 'context.summary.discarded', { attemptKey: job.attemptKey, reason: 'cancelled or authoritative prefix/decision changed' }); return false;
      }
      store.updateRun(run.id, { contextRef: store.blob(restoration.messages), ...(prefix.instructions ? { instructions: prefix.instructions.state } : {}) });
      if (prefix.instructions) recordInstructions(store, run.id, 'compaction', prefix.instructions.chain);
      rememberSummary(store, run.id, result.text, summaryRef);
      if (rebuilt.archivedRef) store.event(run.id, 'context.compacted', { ...rebuilt, messages: undefined, summaryPlan: undefined, summarySkipped: undefined, targetTokens, targetMet: rebuilt.estimatedInputTokens <= targetTokens });
      store.event(run.id, 'context.summary.installed', {
        summaryRef, previousSummaryRef: job.previousSummaryRef, attemptKey: job.attemptKey, archivedRef, coveredOffsets: foldOffsets, coverageHash,
        beforeTokens: built.estimatedInputTokens, afterTokens: restoration.afterTokens, fixedTokens: job.plan.fixedTokens, installTargetTokens, targetMet: restoration.afterTokens <= installTargetTokens,
        restoration: { files: restoration.files.map(({ excerpt: _excerpt, ...file }) => { void _excerpt; return file; }), budget: restoration.budget, usedTokens: restoration.usedTokens, candidates: foldedFiles(job) },
        restorationMessage: restoration.messages.length > rebuilt.messages.length ? restoration.messages.at(-1)!.content : undefined,
        usage: result.usage, droppedGroups: result.droppedGroups, marker,
      });
      return true;
    });
  } catch (error) {
    if (!(error instanceof KodoError)) throw error;
    store.event(run.id, 'context.summary.failed', { attemptKey: job.attemptKey, reason: errorText(error) }); return false;
  }
}

