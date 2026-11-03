import { attachment } from './attachments.js';
import type { Store } from '../storage/index.js';
import { deliverableStatus, describeUnsatisfied } from './deliverables.js';
import { KodoError, terminal } from './types.js';
import { childCompletionState } from './child-completion.js';
import type { Message, ModelResponse, Run } from './types.js';

/** Forced continuations in a row after the model stopped with unsatisfied deliverables. */
export const maxDeliveryContinuations = 2;
const auditEvent = 'delivery.audit_requested';

/** Codex-style completion audit: one line per unsatisfied item, with all tools still available. */
export function deliveryAuditNotice(unsatisfied: readonly string[], attempt: number): string {
  return [
    `Runtime completion audit (${attempt}/${maxDeliveryContinuations}): you stopped, but these host-declared deliverables are not satisfied in the workspace right now:`,
    ...unsatisfied.map(line => `- ${line}`),
    'Before finishing, audit each requirement of the task against the actual files: create or complete every missing item with file tools, run the relevant checks, and only then reply with what changed and what was verified.',
    'If an item cannot be produced, say exactly why in the final reply. This is execution feedback, not permission to widen access.',
  ].join('\n');
}

/** Audit requests since the run last executed a tool; any tool activity resets the streak. */
function consecutiveAudits(store: Store, runId: string): number {
  const after = store.latestEvent(runId, { types: ['tool.started'] })?.seq ?? 0;
  return store.countEvents(runId, { types: [auditEvent], after });
}

/**
 * Turn-end deliverable check for a main run whose model stopped without tool calls.
 * Unsatisfied deliverables return the stop to the model with a completion audit at
 * most twice in a row; afterwards the run proceeds to completion and records the
 * missing items in `deliveryIncomplete` instead of hiding them.
 */
export function turnEndDelivery(store: Store, run: Run, response: ModelResponse): 'continue' | 'proceed' {
  if (run.parentId || !run.deliverables?.length || store.inbox(run.id).length) return 'proceed';
  // The assigned writer may still be producing these files. Child completion
  // handles waiting/resumption before auditing the finished deliverable.
  const children = childCompletionState(store, run);
  if (children.active.length || children.interrupted.length) return 'proceed';
  const workspace = store.session(run.sessionId).workspace;
  const statuses = deliverableStatus(workspace, run.deliverables, Date.parse(run.createdAt));
  const unsatisfied = describeUnsatisfied(statuses);
  if (!unsatisfied.length) {
    if (run.deliveryIncomplete) store.updateRun(run.id, { deliveryIncomplete: undefined });
    return 'proceed';
  }
  const audits = consecutiveAudits(store, run.id);
  if (audits >= maxDeliveryContinuations) {
    store.transaction(() => {
      store.updateRun(run.id, { deliveryIncomplete: unsatisfied });
      store.event(run.id, 'delivery.incomplete', { unsatisfied, continuations: audits });
    });
    return 'proceed';
  }
  store.transaction(() => {
    const current = store.run(run.id);
    if (terminal(current.status) || current.status === 'interrupted') throw new KodoError('RECOVERY_REQUIRED', 'run ended or paused during the delivery audit');
    const context = store.readBlob<Message[]>(current.contextRef);
    context.push(response.message, attachment('delivery-audit', deliveryAuditNotice(unsatisfied, audits + 1)));
    store.updateRun(run.id, { contextRef: store.blob(context), stepCallId: undefined, step: current.step + 1 });
    store.event(run.id, auditEvent, { unsatisfied, attempt: audits + 1 });
  });
  return 'continue';
}
