import type { Store } from '../storage/index.js';
import { collaborationTool } from '../messaging/index.js';
import { deliveryState, renderDeliveryState } from './delivery-state.js';
import type { Call, ModelResponse, Run, StepOutcome, ToolRequest } from './types.js';

/** Identical call+result streak lengths that add an advisory notice. */
export const repeatNoticeAt: readonly number[] = [3, 5, 8];
/** Identical call+result streak that stops the run as having no progress. */
export const repeatBreakerAt = 12;
/** Consecutive model responses that were blank or whose every tool call failed. */
export const failedStepBreakerAt = 6;

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);

/** A queued operation did not execute; resource contention is not a model error. */
function resourceWait(store: Store, call: Call): boolean {
  if (!call.resultRef || call.effectState === 'started') return false;
  const result = store.readBlob<{ error?: string; notStarted?: boolean }>(call.resultRef);
  return result?.notStarted === true && typeof result.error === 'string' && /^(LOCK_TIMEOUT|RESOURCE_WAIT_TIMEOUT):/.test(result.error);
}

/**
 * Call and outcome identity. Changed file hashes or results are progress; repeated
 * nonzero process exits count as the same failure even when runner text differs,
 * and a successful process is never identical because its side effects are unknown.
 */
function signature(store: Store, call: Call): string | undefined {
  if (!call.resultRef) return undefined;
  let args: string;
  try { args = canonical(JSON.parse(store.readBlob<ToolRequest>(call.requestRef).arguments)); } catch { return undefined; }
  const value = store.readBlob<Record<string, unknown>>(call.resultRef);
  const processCall = call.name === 'process.exec' || call.name === 'shell.exec';
  const outcome = processCall && value?.exitCode === 0 ? `successful-process:${call.id}`
    : processCall && typeof value?.exitCode === 'number' ? `exit:${value.exitCode}` : canonical(value);
  return `${args}\n${outcome}`;
}

/** Length of the identical call+result streak that ends with the latest finished tool call. */
export function identicalStreak(store: Store, runId: string): { name: string; count: number } | undefined {
  const done = store.calls(runId).filter(call => call.kind === 'tool' && ['succeeded', 'failed'].includes(call.status));
  const last = done.at(-1);
  if (!last || collaborationTool(last.name) || last.name === 'artifact.write' || resourceWait(store, last)) return undefined;
  const key = signature(store, last);
  if (!key) return undefined;
  let count = 0;
  for (const call of done.toReversed()) {
    if (call.name !== last.name || (call.decisionVersion ?? 0) !== (last.decisionVersion ?? 0) || signature(store, call) !== key) break;
    count++;
  }
  return { name: last.name, count };
}

export function repeatNotice(name: string, count: number): string {
  return `Runtime progress check: ${name} returned the same result for the same arguments ${count} times in a row. Repeating it adds no new evidence. Change the arguments, inspect a different source or fix the underlying problem, then continue. This is execution feedback, not permission to widen access.`;
}

/** Consecutive latest main-step responses that were blank or had only failed tool calls. */
export function failedStepStreak(store: Store, runId: string): number {
  let count = 0;
  for (const model of store.calls(runId).filter(call => call.kind === 'model' && !call.purpose && call.status === 'succeeded' && call.resultRef).toReversed()) {
    const response = store.readBlob<ModelResponse>(model.resultRef!);
    const requests = response.message.tool_calls ?? [];
    const blank = !requests.length && !(response.message.content ?? '').trim();
    const failed = requests.length > 0 && requests.every(request => {
      try {
        const call = store.call(`${model.id}:${request.id}`);
        return ['failed', 'cancelled'].includes(call.status) && !resourceWait(store, call);
      } catch { return false; }
    });
    if (!blank && !failed) break;
    count++;
  }
  return count;
}

/**
 * Stops a run with a durable handoff report: the runtime delivery state (objective,
 * deliverables, changed files, last commands, unresolved failures) so a person or a
 * follow-up run can continue without replaying the transcript.
 */
export function handoffFailure(store: Store, run: Run, code: string, reason: string): StepOutcome {
  const report = `Runtime handoff report: ${code}: ${reason}\n${renderDeliveryState(deliveryState(store, store.run(run.id)))}`;
  const reportRef = store.blob({ text: report });
  store.event(run.id, 'run.handoff', { code, reason, reportRef });
  return { kind: 'fail', error: `${code}: ${reason}; handoff report ${reportRef}` };
}
