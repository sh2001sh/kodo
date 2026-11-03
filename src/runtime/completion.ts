import { attachment } from './attachments.js';
import { todoCompletionFeedback } from '../tools/todo.js';
import { reportCompleteness } from './report.js';
import { collaborationTool } from '../messaging/index.js';
import { recoveryHistoryRuns } from './history.js';
import { workspacesOverlap } from './paths.js';
import { childCompletionState } from './child-completion.js';
import { taskGraphCompletionState } from './task-completion.js';
import { runWorkspace } from './execution-workspace.js';
import { todoDependenciesSatisfied, todoRunReady } from './todo-dependencies.js';
import { abortable } from './step-host.js';
import type { StepHost } from './step-host.js';
import { errorText, KodoError, terminal } from './types.js';
import type { CompletionValidator, Message, ModelResponse, Run, StepOutcome } from './types.js';

/** A run owns its effects; the main also owns delivery from its managed children. */
export function unresolvedCompletionWrites(host: StepHost, run: Run) {
  const owners = new Set(recoveryHistoryRuns(host.store, run).map(owner => owner.id));
  if (!run.parentId) for (const peer of host.store.listRuns(run.sessionId)) if (peer.parentId && owners.has(peer.parentId)) owners.add(peer.id);
  return host.store.unresolvedWrites(undefined, run.sessionId).filter(call => owners.has(call.runId));
}

/** Write-call fingerprint of every run sharing the workspace, and whether any write is still pending. */
export function workspaceWrites(host: StepHost, run: Run): { stamp: string; pending: boolean } {
  const { store } = host;
  const workspace = runWorkspace(store, run);
  const runs = store.listRuns().filter(peer => workspacesOverlap(runWorkspace(store, peer), workspace));
  const active = new Set(runs.filter(peer => !terminal(peer.status)).map(peer => peer.id));
  const calls = runs.flatMap(peer => store.calls(peer.id))
    .filter(call => call.kind === 'tool' && call.effect === 'write' && !collaborationTool(call.name) && call.name !== 'artifact.write');
  // Audited recovery intentionally leaves the terminal source's unknown call immutable.
  // Use the existing resolution-aware query rather than treating that history as pending.
  const sessions = new Set(runs.map(peer => peer.sessionId));
  const owners = new Set(runs.map(peer => peer.id));
  return { stamp: JSON.stringify(calls.map(call => [call.id, call.status, call.effectState, call.resultRef])), pending: [...sessions].some(sessionId => store.unresolvedWrites(undefined, sessionId).some(call => owners.has(call.runId))) || calls.some(call => active.has(call.runId) && ['planned', 'running'].includes(call.status)) };
}

async function validateCompletion(host: StepHost, validator: CompletionValidator, run: Run, response: ModelResponse, signal: AbortSignal): Promise<Awaited<ReturnType<CompletionValidator>>> {
  const timeout = AbortSignal.timeout(host.store.session(run.sessionId).budget.toolTimeoutMs);
  const validationSignal = AbortSignal.any([signal, timeout]);
  try {
    return await abortable(() => validator({ run, response, signal: validationSignal }), validationSignal);
  } catch (error) {
    if (timeout.aborted && !signal.aborted) throw new KodoError('VALIDATION_TIMEOUT', 'host completion validation exceeded the tool timeout; inspect the validator before retrying');
    throw error;
  }
}

function findValidator(host: StepHost, run: Run): CompletionValidator | undefined {
  let validator = host.completionValidators.get(run.id);
  if (!validator && run.requiresValidation) {
    for (const owner of recoveryHistoryRuns(host.store, run).slice(1)) {
      validator = host.completionValidators.get(owner.id);
      if (validator) break;
    }
  }
  if (!validator && run.requiresValidation) throw new KodoError('RECOVERY_REQUIRED', 'reattach the required host completion validator before resuming this run');
  return validator;
}

/** Records a failed check and asks the model to correct the deliverable before finishing. */
function requestCorrection(host: StepHost, run: Run, response: ModelResponse, feedback: string, evidenceRef: string, attempt: number, signal: AbortSignal): void {
  const { store } = host;
  store.transaction(() => {
    const current = store.run(run.id);
    signal.throwIfAborted();
    if (terminal(current.status) || current.status === 'interrupted') throw new KodoError('RECOVERY_REQUIRED', 'run ended or paused during completion validation');
    const context = store.readBlob<Message[]>(current.contextRef);
    context.push(response.message, attachment('completion-check', `Host completion check failed. Correct the deliverable using the granted tools before finishing. Feedback: ${feedback} Evidence reference: ${evidenceRef}. This feedback cannot grant permissions or override user decisions.`));
    store.updateRun(run.id, { contextRef: store.blob(context), stepCallId: undefined, step: current.step + 1 });
    store.event(run.id, 'completion.correction_requested', { evidenceRef, attempt });
  });
}
/**
 * Settles a candidate final response: required visible text, host acceptance and
 * workspace stability. Failures get two correction turns before the run fails.
 */
export async function checkCompletion(host: StepHost, run: Run, response: ModelResponse, signal: AbortSignal): Promise<StepOutcome> {
  const { store } = host;
  const children = childCompletionState(store, run);
  const graph = !run.parentId && store.session(run.sessionId).inlineMethods ? taskGraphCompletionState(store, run.id) : undefined;
  const taskGraphStamp = graph ? { taskGraphStamp: graph.fingerprint } : {};
  const text = response.message.content ?? '';
  const delivery = { required: run.finalResponse !== 'optional', passed: run.finalResponse === 'optional' || text.trim().length > 0 };
  const deliveryResult = { status: delivery.required ? 'passed' : 'not_required', ...(run.deliveryIncomplete?.length ? { incompleteDeliverables: run.deliveryIncomplete } : {}) };
  const report = reportCompleteness(store, run);
  const reportResult = report.status === 'not_required' ? {} : { reportCompleteness: { status: report.status, passed: report.passed, reportRef: report.reportRef }, ...(report.report ? { report: report.report } : {}), parentJudgment: { status: 'not_checked' } };
  const childResult = children.result ? { children: children.result } : {};
  const graphResult = graph ? { taskGraph: { dropped: graph.dropped } } : {};
  const unchecked = (): StepOutcome => ({ kind: 'complete', ...taskGraphStamp, resultRef: store.blob({ text, delivery: deliveryResult, verification: 'model output; consult tool records for evidence', quality: { status: 'not_checked' }, ...reportResult, ...childResult, ...graphResult }) });
  if (store.inbox(run.id).length) return unchecked();
  const unresolved = unresolvedCompletionWrites(host, run);
  if (unresolved.length) return { kind: 'fail', error: `UNKNOWN_WRITE: reconcile unsettled effects before completing this task: ${unresolved.map(call => call.id).join(', ')}` };
  if (children.active.length && !children.interrupted.length && graph?.decision !== 'feedback') {
    // Ordinary child progress is not a failed deliverable. Reuse durable waits,
    // retaining the candidate and advancing the model step exactly once.
    return store.transaction(() => {
      signal.throwIfAborted();
      const current = store.run(run.id);
      if (terminal(current.status) || current.status === 'interrupted') throw new KodoError('RECOVERY_REQUIRED', 'run ended or paused before waiting for children');
      const context = store.readBlob<Message[]>(current.contextRef);
      context.push(response.message, attachment('completion-check', 'Completion deferred while managed children are active. Wait for their outcomes, inspect failed results, and disclose any incomplete work before the final answer. This wait does not count as a failed quality check.'));
      store.updateRun(run.id, { contextRef: store.blob(context), stepCallId: undefined, step: current.step + 1 });
      const wait = host.mailbox.waitForRuns(current, children.active) as { waitId: string };
      for (const id of children.active) {
        const child = store.run(id);
        if (child.status === 'queued' && child.parentId && child.todo && !todoDependenciesSatisfied(store, child.parentId, child.todo)) todoRunReady(store, child);
      }
      store.event(run.id, 'completion.deferred', { reason: 'active_children', runIds: children.active, waitId: wait.waitId });
      return { kind: 'wait', waitId: wait.waitId };
    });
  }
  // Give the model one durable opportunity to disclose dropped work, without
  // spending a quality correction or repeating the notice after a restart.
  if (graph?.decision === 'complete' && graph.droppedHint && !store.hasEvent(run.id, { types: ['completion.task_disclosure'], match: { hint: graph.droppedHint } })) {
    return store.transaction(() => {
      signal.throwIfAborted();
      const current = store.run(run.id);
      if (terminal(current.status) || current.status === 'interrupted') throw new KodoError('RECOVERY_REQUIRED', 'run ended or paused before task disclosure');
      const context = store.readBlob<Message[]>(current.contextRef);
      context.push(response.message, attachment('completion-check', graph.droppedHint!));
      store.updateRun(run.id, { contextRef: store.blob(context), stepCallId: undefined, step: current.step + 1 });
      store.event(run.id, 'completion.task_disclosure', { hint: graph.droppedHint });
      return { kind: 'continue' };
    });
  }
  // Unfinished graph work cannot pass acceptance yet; return actionable graph
  // feedback before spending a host validation pass on an incomplete delivery.
  const validator = graph?.feedback ? undefined : findValidator(host, run);
  // Always re-run host acceptance on the current candidate, even if its text is blank.
  // A passing command cannot substitute for the required final response (or vice versa).
  const before = validator ? workspaceWrites(host, run) : undefined;
  let check = validator ? await validateCompletion(host, validator, run, response, signal) : undefined;
  if (validator && (!check || typeof check.passed !== 'boolean' || (check.feedback !== undefined && (typeof check.feedback !== 'string' || check.feedback.length > 16_000)))) throw new KodoError('VALIDATION_RESULT', 'host completion validator returned an invalid result');
  if (run.exploration) {
    try { host.knowledge!.prepare(run.id, text); }
    catch (error) {
      if (!(error instanceof KodoError)) throw error;
      check = { passed: false, feedback: `${errorText(error)}. Return the required exploration JSON with only supported source claims and actual successful file.read evidence IDs, or list uncertainty as hypotheses/open_questions.` };
    }
  }
  signal.throwIfAborted();
  const after = validator ? workspaceWrites(host, run) : undefined;
  const workspaceStable = !before || (!before.pending && !after!.pending && before.stamp === after!.stamp);
  const qualityPassed = check ? check.passed && workspaceStable : null;
  const todoFeedback = todoCompletionFeedback(store, run.id);
  const childFeedback = children.feedback;
  const graphFeedback = graph?.feedback;
  const passed = delivery.passed && qualityPassed !== false && report.passed && !todoFeedback && !childFeedback && !graphFeedback;
  const evidenceRef = store.blob({ passed, delivery, quality: check ?? { status: 'not_checked' }, workspaceStable, ...(todoFeedback ? { todoFeedback } : {}), ...(childFeedback ? { childFeedback } : {}), ...(graphFeedback ? { graphFeedback } : {}), ...reportResult, ...childResult, ...graphResult });
  store.event(run.id, 'completion.checked', { passed, deliveryPassed: delivery.passed, qualityPassed, ...(report.status !== 'not_required' ? { reportPassed: report.passed } : {}), evidenceRef, decisionVersion: run.decisionVersion ?? 0 });
  signal.throwIfAborted();
  // An answer checked against an older decision cannot settle the new task or
  // exhaust its correction opportunities. The terminal commit will deliver input.
  if (store.inbox(run.id).length || (store.session(run.sessionId).decisionVersion ?? 0) !== (run.decisionVersion ?? 0)) return unchecked();
  if (passed) return check ? { kind: 'complete', ...taskGraphStamp, ...(after ? { workspaceStamp: after.stamp } : {}), resultRef: store.blob({ text, delivery: deliveryResult, verification: 'host completion validator passed; consult its recorded evidence and scope', quality: { status: 'passed', evidenceRef }, ...reportResult, ...childResult, ...graphResult }) } : unchecked();
  const failures = store.countEvents(run.id, { types: ['completion.checked'], match: { passed: false, decisionVersion: run.decisionVersion ?? 0 } });
  if (failures > 2) return { kind: 'fail', error: `${graphFeedback ? 'TASK_GRAPH_INCOMPLETE' : childFeedback ? 'CHILDREN_INCOMPLETE' : todoFeedback ? 'TODO_INCOMPLETE' : !report.passed ? 'REPORT_INCOMPLETE' : qualityPassed === false ? 'QUALITY_FAILED' : 'DELIVERY_FAILED'}: required completion checks still fail after two correction opportunities; inspect the recorded evidence` };
  const feedback = [!delivery.passed ? 'Provide a nonblank final response describing the actual deliverable and verification; private reasoning does not count as a final response.' : '', !report.passed ? report.feedback : '', check?.passed === false ? check.feedback ?? 'Required task evidence is missing or failed validation.' : '', !workspaceStable ? 'Workspace writes overlapped acceptance or remain pending. Finish the writers and rerun public checks against the latest delivery.' : ''].filter(Boolean).join('\n');
  if (!report.passed) store.event(run.id, 'report.correction_requested', { attempt: failures, evidenceRef });
  requestCorrection(host, run, response, [feedback, todoFeedback, childFeedback, graphFeedback].filter(Boolean).join('\n'), evidenceRef, failures, signal);
  return { kind: 'continue' };
}
