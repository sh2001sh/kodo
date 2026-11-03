import type { Store } from '../storage/index.js';
import { authorizedHistoryRuns, readHistory } from './history.js';
import { KodoError } from './types.js';
import { parseHistoryPointer } from './view-pointers.js';
import type { SummaryEnvelope, SummarySource } from './summary-schema.js';

export interface SummarySourceRequest {
  summary: string; source: string; contentOffset?: number; maxChars?: number;
}

/** Version-independent view of an installed checkpoint for inspection and the workbench. */
export interface SummaryView {
  version: 1 | 2; archivedRef: string; coveredOffsets: number[]; previousSummaryRef?: string;
  text?: string; content?: unknown; sources?: SummarySource[];
  beforeTokens?: number; afterTokens?: number; usage?: unknown;
}

const summaryRefPattern = /^[a-f0-9]{64}$/;

function invalidSource(message: string): never { throw new KodoError('SUMMARY_SOURCE', message); }

/** Read either envelope version without interpreting summary content as authority. */
export function readSummaryEnvelope(store: Store, summaryRef: string): SummaryView | undefined {
  const envelope = store.readBlob<SummaryEnvelope>(summaryRef);
  if (!envelope || typeof envelope !== 'object' || typeof envelope.archivedRef !== 'string' || !Array.isArray(envelope.coveredOffsets)) return;
  const common = { archivedRef: envelope.archivedRef, coveredOffsets: envelope.coveredOffsets, ...(envelope.previousSummaryRef ? { previousSummaryRef: envelope.previousSummaryRef } : {}), beforeTokens: envelope.beforeTokens, afterTokens: envelope.afterTokens, usage: envelope.usage ?? null };
  if (envelope.version === 2 && typeof envelope.text === 'string') return { version: 2, ...common, text: envelope.text };
  if (envelope.version === 1) return { version: 1, ...common, content: envelope.content, sources: Array.isArray(envelope.sources) ? envelope.sources : [] };
  return;
}

/**
 * Resolve a short source id cited by a legacy v1 summary checkpoint and return
 * the original recorded evidence through readHistory.
 *
 * Resolution order is fixed: current read authorization, an installed event
 * indexed on the authorized history chain, envelope version/source-index
 * validation, an exact short-id match, then the unchanged readHistory archive
 * authorization, scope, visibility, redaction and missing/corruption checks.
 * v2 free-text checkpoints carry no short ids; their marker names an exact
 * history.read ref/offset pointer instead, so source mode fails explicitly.
 */
export function readSummarySource(store: Store, requesterId: string, request: SummarySourceRequest): ReturnType<typeof readHistory> {
  if (typeof request?.summary !== 'string' || !request.summary) throw new KodoError('HISTORY_ARGUMENTS', 'summary must be the 64-hex reference of an installed summary checkpoint');
  if (typeof request.source !== 'string' || !request.source) invalidSource('unknown or stale summary source reference; copy an S id from the installed summary marker');
  const requester = store.run(requesterId);
  const authorized = authorizedHistoryRuns(store, requester);
  const installed = authorized.flatMap(run => store.events(run.id, { types: ['context.summary.installed'], match: { summaryRef: request.summary } }))[0];
  if (!installed) throw new KodoError('HISTORY_DENIED', 'summary reference is not indexed on this run or its authorized history');
  const envelope = store.readBlob<SummaryEnvelope>(request.summary);
  if (envelope?.version === 2 && typeof envelope.text === 'string') invalidSource('this summary checkpoint has no short source ids; use the history.read ref and offset printed in its marker');
  if (!envelope || typeof envelope !== 'object' || envelope.version !== 1 || !Array.isArray(envelope.sources)) invalidSource('installed summary envelope is invalid or unsupported; short source references cannot be resolved');
  const source = envelope.sources.find(entry => entry !== null && typeof entry === 'object' && entry.short === request.source);
  if (!source) invalidSource(`unknown or stale summary source reference ${JSON.stringify(request.source.slice(0, 80))}; the cited checkpoint version does not map this id`);
  // Either rendered pointer shape normalizes to one history.read position. A
  // matched short id must delegate to its own immutable recorded message; a
  // malformed entry is a corrupt checkpoint, never a reason to try another source.
  const args = parseHistoryPointer(source.read);
  if (!args || !summaryRefPattern.test(args.ref)) invalidSource('installed summary source entry is not a readable history reference');
  return readHistory(store, requesterId, { ref: args.ref, offset: args.offset, limit: 1, ...(request.contentOffset === undefined ? {} : { contentOffset: request.contentOffset }), ...(request.maxChars === undefined ? {} : { maxChars: request.maxChars }) });
}
