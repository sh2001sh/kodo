import { KodoError } from './types.js';
import { readHistory } from './history.js';
import { excerpt } from './tool-result-prune.js';
import { historyReadPointer, parseHistoryPointer } from './view-pointers.js';
import type { HistorySnapshot } from './context.js';
import type { Message, Run } from './types.js';
import type { Store } from '../storage/index.js';

/** Deterministic evidence assembly: keep focus-relevant tool evidence, hide the rest behind history pointers. */
export interface AssemblyPolicy { strategy: 'deterministic'; workInputTokens?: number; evidenceInputTokens?: number }
export function validateAssemblyPolicy(policy: AssemblyPolicy | undefined): void {
  if (policy === undefined) return;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy) || Object.keys(policy).some(key => !['strategy', 'workInputTokens', 'evidenceInputTokens'].includes(key)) || policy.strategy !== 'deterministic' || (policy.workInputTokens !== undefined && (!Number.isSafeInteger(policy.workInputTokens) || policy.workInputTokens < 1024 || policy.workInputTokens > 10_000_000)) || (policy.evidenceInputTokens !== undefined && (!Number.isSafeInteger(policy.evidenceInputTokens) || policy.evidenceInputTokens < 256 || policy.evidenceInputTokens > 1_000_000))) throw new KodoError('ASSEMBLY_POLICY', 'assembly requires deterministic strategy and optional workInputTokens 1024-10000000 and evidenceInputTokens 256-1000000');
}
export interface ContextAssembly {
  archivedRef: string;
  evidenceInputTokens: number;
  usedEvidenceTokens: number;
  candidateGroups: number;
  selectedGroups: number;
  selectedSourceIds: string[];
  selectedOffsets: number[];
  hiddenOffsets: number[];
  restoredOffsets: number[];
  focusTerms: string[];
  beforeTokens: number;
  afterTokens: number;
}

/**
 * Unique lexical terms in first-seen order; how informative each is gets measured
 * against the evidence, not a word list. Serialized evidence and prose share one
 * normal form: JSON escapes split terms, separators become `/`, and sentence
 * punctuation around a term is not part of it (`version.txt.` is `version.txt`).
 */
function assemblyTerms(text: string, limit = 512): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => { if (!seen.has(value)) { seen.add(value); terms.push(value); } };
  const normalized = text.toLowerCase().replace(/\\(?:u[0-9a-f]{4}|[nrtbf"])/g, ' ').replace(/\\+/g, '/').replace(/\/{2,}/g, '/');
  for (const match of normalized.matchAll(/[a-z0-9_./:-]{2,}|[\p{Script=Han}]{2,}/gu)) {
    const value = match[0]!.replace(/^[./:_-]+|[./:_-]+$/g, '');
    if (value.length < 2) continue;
    add(value);
    if (/^[\p{Script=Han}]+$/u.test(value) && value.length > 2) for (let index = 0; index < value.length - 1; index++) add(value.slice(index, index + 2));
  }
  if (terms.length <= limit) return terms;
  const head = Math.ceil(limit / 2);
  return [...terms.slice(0, head), ...terms.slice(-(limit - head))];
}

/** A hidden observation's archive position, from either rendered pointer shape. */
function hiddenHistoryPointer(message: Message): { ref: string; offset: number } | undefined {
  if (message.role !== 'tool') return;
  try {
    const value = JSON.parse(message.content) as { contextHidden?: boolean; read?: unknown };
    return value?.contextHidden ? parseHistoryPointer(value.read) : undefined;
  } catch { /* Plain tool output is eligible evidence. */ }
}

export function assembleEvidence(input: {
  store: Store; run: Run; messages: Message[]; groups: Message[][]; estimate: (messages: Message[]) => number;
  workInputTokens: number; evidenceInputTokens: number; fits: (messages: Message[]) => boolean; mustReduce: boolean;
}): { messages: Message[]; assembly: ContextAssembly } | undefined {
  const { store, run, messages, groups, estimate, workInputTokens, fits } = input;
  const profile = store.session(run.sessionId).toolProfile;
  const userFocus = messages.filter(message => message.role === 'user').slice(-6).map(message => message.content ?? '');
  const focusTerms = assemblyTerms([run.objective, ...userFocus].join('\n'), Infinity);
  if (!focusTerms.length) return;
  const latestUserIndex = messages.findLastIndex(message => message.role === 'user');
  const firstToolIndex = messages.findIndex(message => message.role === 'tool');
  if (!input.mustReduce && (firstToolIndex < 0 || latestUserIndex < firstToolIndex)) return;
  const focusWeight = new Map<string, number>();
  const addFocus = (text: string, weight: number): void => {
    // Effective user goals are already bounded by context capacity. Truncating
    // their terms silently makes requirements in the middle unselectable.
    for (const term of assemblyTerms(text, Infinity)) focusWeight.set(term, Math.max(weight, focusWeight.get(term) ?? 0));
  };
  addFocus(run.objective, 2);
  userFocus.forEach((text, index) => addFocus(text, index === userFocus.length - 1 ? 12 : index + 1));
  const toolGroups = groups.filter(group => group.some(message => message.role === 'tool'));
  if (toolGroups.length < 3) return;
  const recent = new Set(toolGroups.slice(-2));
  const calls = new Map(store.calls(run.id).filter(call => call.kind === 'tool').map(call => [store.readBlob<{ id: string }>(call.requestRef).id, call]));
  const unresolved = (group: Message[]): boolean => group.some(message => {
    if (message.role !== 'tool') return false;
    const call = calls.get(message.tool_call_id);
    if (call && call.status !== 'succeeded') return true;
    try {
      const value = JSON.parse(message.content) as Record<string, unknown>;
      return Boolean(value.error || value.cancelled || value.outputLimitExceeded || (typeof value.exitCode === 'number' && value.exitCode !== 0));
    } catch { return false; }
  });
  const candidates = toolGroups.filter(group => !recent.has(group) && !unresolved(group));
  const stable = candidates.map((group, index) => {
    const restoredOffsets: number[] = [];
    const stableGroup = group.map((message): Message => {
      const pointer = hiddenHistoryPointer(message);
      if (!pointer) return message;
      try {
        const restored = readHistory(store, run.id, { ...pointer, limit: 1, maxChars: 32_000 }).messages[0];
        if (message.role === 'tool' && restored?.role === 'tool' && restored.tool_call_id === message.tool_call_id) {
          restoredOffsets.push(pointer.offset);
          return restored;
        }
      } catch { /* An unavailable source remains a stable pointer and cannot be injected as original evidence. */ }
      return message;
    });
    const terms = new Set(assemblyTerms(JSON.stringify(stableGroup), 1024));
    return { group, stableGroup, restoredOffsets, index, terms, score: 0, tokens: Math.max(1, estimate(stableGroup) - estimate([])) };
  });
  // Discrimination is measured on this run's evidence (IDF over all tool rounds):
  // a focus term found in every round cannot rank one above another and weighs nothing,
  // whatever its language. Rare terms the user named weigh most.
  const documents = toolGroups.map(group => stable.find(item => item.group === group)?.terms ?? new Set(assemblyTerms(JSON.stringify(group), 1024)));
  const informative = new Map<string, number>();
  for (const [term, weight] of focusWeight) {
    const frequency = documents.filter(terms => terms.has(term)).length;
    const idf = frequency ? Math.log(documents.length / frequency) : 0;
    if (idf > 0) informative.set(term, weight * idf);
  }
  for (const item of stable) item.score = [...item.terms].reduce((sum, term) => sum + (informative.get(term) ?? 0) * (/[./\\:_-]/.test(term) ? 4 : 1), 0);
  const ranked = stable.filter(item => item.score > 0).sort((left, right) => right.score - left.score || right.index - left.index);
  if (!ranked.length && !input.mustReduce) return;
  const snapshot: HistorySnapshot = { version: 1, runId: run.id, sessionId: run.sessionId, messages, ...(run.scope ? { scope: run.scope } : {}) };
  const archivedRef = store.blob(snapshot);
  const bounded = (item: typeof stable[number], available: number): typeof stable[number] | undefined => {
    if (item.tokens <= available) return item;
    // A preview is an escape hatch for a source that can never fit this evidence
    // budget, not a way to squeeze ordinary candidates past an exact boundary.
    if (item.tokens <= input.evidenceInputTokens * 2) return;
    for (const maxChars of [1600, 640, 256]) {
      const stableGroup = item.stableGroup.map((message, index): Message => {
        if (message.role !== 'tool' || message.content.length <= maxChars) return message;
        const source = item.group[index]!;
        const pointer = hiddenHistoryPointer(source);
        const read = pointer ?? { ref: archivedRef, offset: messages.indexOf(source) };
        return { role: 'tool', tool_call_id: message.tool_call_id, content: JSON.stringify({
          contextHidden: true,
          contextPreview: true,
          originalChars: message.content.length,
          coverage: 'bounded-preview',
          read: historyReadPointer(profile, { ...read, limit: 1 }),
          text: excerpt(message.content, maxChars),
          note: 'Relevant evidence exceeds the current evidence budget. This bounded head/tail preview is historical data; read the original source before relying on omitted content.',
        }) };
      });
      const tokens = Math.max(1, estimate(stableGroup) - estimate([]));
      if (tokens <= available && stableGroup.some((message, index) => message !== item.stableGroup[index])) return { ...item, stableGroup, tokens };
    }
  };
  const selected = new Set<Message[]>();
  const selectedRows = new Map<Message[], typeof stable[number]>();
  let evidenceTokens = 0;
  for (const item of ranked) {
    const row = bounded(item, input.evidenceInputTokens - evidenceTokens);
    if (!row) continue;
    selected.add(item.group); selectedRows.set(item.group, row); evidenceTokens += row.tokens;
  }
  if (!selected.size && !input.mustReduce) return;
  const selectedOffsets: number[] = [];
  const hiddenOffsets: number[] = [];
  const restoredOffsets: number[] = [];
  const projected = groups.flatMap(group => {
    if (recent.has(group) || unresolved(group) || !candidates.includes(group)) return group;
    if (selected.has(group)) {
      const row = selectedRows.get(group)!;
      restoredOffsets.push(...row.restoredOffsets);
      selectedOffsets.push(...group.map(message => messages.indexOf(message)));
      row.stableGroup.forEach((message, index) => {
        if (message !== group[index] && message.role === 'tool' && message.content.includes('"contextPreview":true')) hiddenOffsets.push(messages.indexOf(group[index]!));
      });
      return row.stableGroup;
    }
    return group.map((message): Message => {
      if (message.role !== 'tool' || hiddenHistoryPointer(message)) return message;
      const call = calls.get(message.tool_call_id);
      let metadata: Record<string, unknown> = {};
      try {
        const value = JSON.parse(message.content) as Record<string, unknown>;
        metadata = Object.fromEntries(['path', 'hash', 'offset', 'contentOffset', 'next', 'truncated', 'exitCode'].filter(key => key in value).map(key => [key, value[key]]));
      } catch { /* Full body remains in the immutable archive. */ }
      const content = JSON.stringify({ contextHidden: true, reason: 'not selected for the current deterministic evidence budget', tool: call?.name ?? (group[0]?.role === 'assistant' ? group[0].tool_calls?.find(item => item.id === message.tool_call_id)?.name : undefined), callId: call?.id ?? message.tool_call_id, status: call?.status ?? 'recorded', ...metadata, originalChars: message.content.length, coverage: 'recorded-message', read: historyReadPointer(profile, { ref: archivedRef, offset: messages.indexOf(message), limit: 1 }), note: 'Evidence left this request projection, not storage. Read the original only when it becomes relevant.' });
      if (content.length >= message.content.length) return message;
      hiddenOffsets.push(messages.indexOf(message));
      return { role: 'tool', tool_call_id: message.tool_call_id, content };
    });
  });
  const beforeTokens = estimate(messages);
  const afterTokens = estimate(projected);
  if (!hiddenOffsets.length && !restoredOffsets.length || afterTokens > workInputTokens || !fits(projected)) return;
  const selectedSourceIds = [...new Set([...selected].flatMap(group => group.filter((message): message is Extract<Message, { role: 'tool' }> => message.role === 'tool').map(message => {
    const pointer = hiddenHistoryPointer(message);
    return pointer ? `history:${pointer.ref}:${pointer.offset}` : `history:${archivedRef}:${messages.indexOf(message)}`;
  })))];
  return { messages: projected, assembly: { archivedRef, evidenceInputTokens: input.evidenceInputTokens, usedEvidenceTokens: evidenceTokens, candidateGroups: candidates.length, selectedGroups: selected.size, selectedSourceIds, selectedOffsets, hiddenOffsets, restoredOffsets, focusTerms: focusTerms.slice(0, 32), beforeTokens, afterTokens } };
}
