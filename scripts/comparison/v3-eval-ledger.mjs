// Usage ledger and delivery checks shared by the v3 evaluations.
// The ledger reads every persisted model call of a session and classifies it as
// measured, known zero or unknown. Unknown spending is never counted as zero:
// `complete` is false whenever one call has no usage, and cost conclusions built
// on the ledger must then be reported as uncertain.
// Kodo normalizes every provider adapter so that cacheRead/cacheWrite are parts
// of `input` (the coordinator rejects cacheRead + cacheWrite > input); uncached
// input is therefore input − cacheRead − cacheWrite, never input + cache.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const emptyRole = () => ({ requests: 0, measured: 0, knownZero: 0, unknown: 0, agentCancelled: 0, unknownReserved: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, uncachedInput: 0, peakInput: 0, toolCalls: 0, rereads: 0, durationMs: 0 });

/** measured | knownZero | unknown, from the call status and its result blob. */
export function classifyModelCall(store, call) {
  let blob;
  try { blob = call.resultRef ? store.readBlob(call.resultRef) : undefined; } catch { blob = undefined; }
  if (call.status === 'succeeded' && blob?.usage && typeof blob.usage === 'object') return { kind: 'measured', usage: blob.usage };
  if (blob?.usage === 'known-zero') return { kind: 'knownZero' };
  return { kind: 'unknown' };
}

function addModelCall(role, outcome, call, agentCancelled) {
  role.requests++;
  role[outcome.kind]++;
  if (outcome.kind === 'unknown') {
    role.unknownReserved += call.reservedTokens ?? 0;
    if (call.status === 'cancelled' && agentCancelled) role.agentCancelled++;
  }
  if (outcome.kind !== 'measured') return;
  const { input, output, cacheRead = 0, cacheWrite = 0 } = outcome.usage;
  role.input += input; role.output += output; role.cacheRead += cacheRead; role.cacheWrite += cacheWrite;
  role.uncachedInput += input - cacheRead - cacheWrite;
  role.peakInput = Math.max(role.peakInput, input);
}

/** Count tool calls and file.read calls whose path this run already read. */
function addToolCall(store, role, call, seenPaths) {
  role.toolCalls++;
  if (call.name !== 'file.read') return;
  let target;
  try { target = JSON.parse(store.readBlob(call.requestRef)?.arguments ?? '{}').path; } catch { target = undefined; }
  if (typeof target !== 'string') return;
  if (seenPaths.has(target)) role.rereads++;
  seenPaths.add(target);
}

/**
 * True when the run was cancelled by its main agent (cancel_agent), directly or as a
 * descendant of such a child. User, shutdown and runtime cancellations do not qualify.
 */
export function agentCancelledRun(store, run) {
  for (let current = run, depth = 0; current && depth < 16; depth++) {
    const origin = store.events(current.id).find(event => event.type === 'run.cancelled')?.data;
    if (!origin) return false;
    if (origin.initiator === 'agent') return true;
    if (origin.initiator !== 'parent' || !origin.by) return false;
    current = store.run(origin.by);
  }
  return false;
}

/** Run span from its events; compaction time is the sum of its model call spans. */
function addTimes(events, work, compaction, span) {
  const started = new Map();
  let first = Infinity, last = -Infinity;
  for (const event of events) {
    const time = Date.parse(event.time);
    first = Math.min(first, time); last = Math.max(last, time);
    if (event.data?.purpose !== 'compaction') continue;
    if (event.type === 'model.started') started.set(event.data.callId, time);
    else if (['model.finished', 'model.failed'].includes(event.type) && started.has(event.data.callId)) compaction.durationMs += time - started.get(event.data.callId);
  }
  if (first > last) return;
  work.durationMs += last - first;
  span.first = Math.min(span.first, first); span.last = Math.max(span.last, last);
}

/**
 * Per-role ledger (main work, compaction, children) of one session plus totals.
 * child.durationMs is the cumulative child time; totals.wallMs is the session
 * span the user waited for. Legacy names (totalTokens, peakMainInput,
 * compactionTokens, compactionShare) keep their earlier meaning over measured calls.
 */
export function usageLedger(store, sessionId) {
  const roles = { main: emptyRole(), compaction: emptyRole(), child: emptyRole() };
  const span = { first: Infinity, last: -Infinity };
  let providerFailures = 0;
  for (const run of store.listRuns(sessionId)) {
    const work = run.parentId ? roles.child : roles.main;
    const seenPaths = new Set();
    const agentCancelled = agentCancelledRun(store, run);
    const cancelledCalls = new Set();
    for (const call of store.calls(run.id)) {
      if (call.status === 'cancelled') cancelledCalls.add(call.id);
      if (call.kind === 'tool') addToolCall(store, work, call, seenPaths);
      else addModelCall(call.purpose === 'compaction' ? roles.compaction : work, classifyModelCall(store, call), call, agentCancelled);
    }
    const events = store.events(run.id);
    // An aborted attempt is a cancellation, not a provider fault.
    providerFailures += events.filter(event => event.type === 'model.failed' && !cancelledCalls.has(event.data?.callId)).length;
    addTimes(events, work, roles.compaction, span);
  }
  const sum = field => roles.main[field] + roles.compaction[field] + roles.child[field];
  const totalTokens = sum('input') + sum('output');
  const compactionTokens = roles.compaction.input + roles.compaction.output;
  const totals = {
    modelCalls: sum('requests'), measuredCalls: sum('measured'), knownZeroCalls: sum('knownZero'), unknownCalls: sum('unknown'),
    // Unknown calls cancelled by the main agent; their reservation is an estimate, not a billing bound.
    agentCancelledUnknown: sum('agentCancelled'), unknownReservedTokens: sum('unknownReserved'),
    inputTokens: sum('input'), outputTokens: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), uncachedInput: sum('uncachedInput'),
    totalTokens, compactionCalls: roles.compaction.requests, compactionTokens, compactionShare: totalTokens ? compactionTokens / totalTokens : 0,
    mainModelCalls: roles.main.requests, peakMainInput: roles.main.peakInput, providerFailures,
    wallMs: span.first <= span.last ? span.last - span.first : 0, childDurationMs: roles.child.durationMs,
    complete: sum('unknown') === 0,
  };
  return { ...totals, roles };
}

function walk(root, relative, files) {
  const absolute = relative ? path.join(root, relative) : root;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const next = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) walk(root, next, files);
    else if (entry.isFile()) files[next] = sha256(readFileSync(path.join(root, next)));
  }
}

/** Hashes of every file under the protected entries ('.' protects the whole tree); missing entries are listed. */
export function protectedSnapshot(workspace, entries) {
  const files = {}, missing = [];
  for (const entry of entries) {
    const relative = entry === '.' ? '' : entry.replace(/\\/gu, '/');
    const absolute = relative ? path.join(workspace, relative) : workspace;
    if (!existsSync(absolute)) { missing.push(entry); continue; }
    if (statSync(absolute).isDirectory()) walk(workspace, relative, files);
    else files[relative] = sha256(readFileSync(absolute));
  }
  return { files, missing };
}

/** Digest of a whole directory tree, used for fixture and frozen-source identity. */
export function treeDigest(root) {
  const { files } = protectedSnapshot(root, ['.']);
  return sha256(JSON.stringify(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))));
}

/**
 * Delivery requires a completed run, a non-empty final reply, the task's own
 * acceptance, and a protected set that is identical in membership and content
 * (an added file under a protected directory fails just like an edit).
 */
export function deliveryCheck({ status, finalText, acceptance, before, after }) {
  const reasons = [];
  if (status !== 'completed') reasons.push('RUN_NOT_COMPLETED');
  if (!String(finalText ?? '').trim()) reasons.push('EMPTY_REPLY');
  if (!acceptance) reasons.push('ACCEPTANCE_FAILED');
  if (before && after) {
    const added = Object.keys(after.files).filter(file => !(file in before.files));
    const removed = [...Object.keys(before.files).filter(file => !(file in after.files)), ...after.missing.filter(entry => !before.missing.includes(entry))];
    const modified = Object.keys(before.files).filter(file => file in after.files && after.files[file] !== before.files[file]);
    if (added.length || removed.length) reasons.push('PROTECTED_SET_CHANGED');
    if (modified.length) reasons.push('PROTECTED_MODIFIED');
    return { ok: reasons.length === 0, reasons, protected: { added, removed, modified } };
  }
  return { ok: reasons.length === 0, reasons };
}
