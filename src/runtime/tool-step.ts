import { collaborationTool, controlTool } from '../messaging/index.js';
import { effectiveMethodRun, recordMethodLoad } from '../extensions/methods.js';
import { assertTodoExecution } from './todo-execution.js';
import { validateImageInput } from '../tools/image.js';
import type { ImageInput } from '../tools/image.js';
import { reconciledEvent } from '../tools/effect-scan.js';
import type { EffectEvidence } from '../tools/effect-scan.js';
import { attachment, orderAttachments } from './attachments.js';
import { exploreNudge } from './explore-nudge.js';
import { changedFilesNotice, changedSinceSeen } from '../tools/read-state.js';
import { backgroundNotice, backgroundUnknown, markReported } from './background-notice.js';
import { beforeWriteInstructions, touchedInstructions } from './instruction-layer.js';
import { repeatedReads, rereadNotice, writeNudge } from './progress-guard.js';
import { failedStepBreakerAt, failedStepStreak, handoffFailure, identicalStreak, repeatBreakerAt, repeatNotice, repeatNoticeAt } from './progress-advisor.js';
import { abortable, effectiveSession } from './step-host.js';
import { commandFailed, siblingStopped, toolBatches } from './tool-batch.js';
import type { StepHost } from './step-host.js';
import { executionSession, runWorkspace } from './execution-workspace.js';
import { canonicalRequest, isLeanProfile, viewResult, viewText } from './tool-view.js';
import { normalizeFileScope, writeScopesOverlap } from './scope.js';
import { errorText, KodoError, terminal } from './types.js';
import type { Call, FileScope, Message, ModelResponse, Permission, Run, StepOutcome, ToolRequest } from './types.js';

const internal = (name: string): boolean => collaborationTool(name) || name === 'artifact.write';

interface SpawnWriteClaim { request: ToolRequest; scope: FileScope | undefined }

/** The write claim a spawn_agent request would add at admission, or undefined when it writes nothing. */
function spawnWriteClaim(host: StepHost, run: Run, request: ToolRequest): SpawnWriteClaim | undefined {
  let args: { permissions?: Permission[]; scope?: FileScope; card_id?: string };
  try { args = JSON.parse(request.arguments) as typeof args; } catch { return undefined; }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const session = host.store.session(run.sessionId);
  const granted = session.permissions.filter(permission => (run.permissions ?? session.permissions).includes(permission));
  if (!(args.permissions ?? granted).includes('write')) return undefined;
  // Mirror assertNoWriteConflict: strict admission treats an omitted write side as the
  // whole workspace, and only a claim narrower than the inherited parent scope competes.
  const strict = Boolean(session.agentFactors?.A || session.agentFactors?.C) || Boolean(args.card_id);
  const write = normalizeFileScope(args.scope ?? {}, run.scope).write;
  const inherited = JSON.stringify([...(run.scope?.write ?? [])].sort());
  let claims = false;
  if (write === undefined) claims = strict;
  else if (write.length > 0) claims = strict || JSON.stringify([...write].sort()) !== inherited;
  return claims ? { request, scope: write === undefined ? undefined : { write } } : undefined;
}

/**
 * One model response is admitted child by child, so the first committed spawn can
 * make every later sibling fail even though the response intended them to coexist.
 * Validate the response's spawn write claims as a group and reject all of them
 * before any child exists, naming the conflicting calls and the fix.
 */
function responseSpawnWriteConflicts(host: StepHost, run: Run, requests: readonly ToolRequest[]): Map<string, KodoError> {
  const rejected = new Map<string, KodoError>();
  const claims = requests.filter(request => request.name === 'spawn_agent')
    .flatMap(request => { const claim = spawnWriteClaim(host, run, request); return claim ? [claim] : []; });
  if (claims.length < 2) return rejected;
  for (let left = 0; left < claims.length; left++) {
    for (let right = left + 1; right < claims.length; right++) {
      const a = claims[left]!, b = claims[right]!;
      if (!writeScopesOverlap(a.scope, b.scope)) continue;
      const message = `the same model response spawns children with overlapping write scopes (${a.request.id}: ${JSON.stringify(a.scope?.write ?? ['.'])}, ${b.request.id}: ${JSON.stringify(b.scope?.write ?? ['.'])}); no child was created. Give every spawn in one response its own disjoint scope.write roots, or create them in separate responses.`;
      const error = new KodoError('WRITE_SCOPE_CONFLICT', message);
      rejected.set(a.request.id, error);
      rejected.set(b.request.id, error);
    }
  }
  return rejected;
}
/** Handle of a managed process or shell command that continues in the background. */
const backgroundOf = (result: unknown): { id: string } | undefined => result && typeof result === 'object' && 'background' in result && !('exitCode' in result) ? (result as { background: { id: string } }).background : undefined;
/** Reconciliation evidence a stopped process attached to its result, if any. */
const evidenceOf = (result: unknown): EffectEvidence | undefined => result && typeof result === 'object' && 'effects' in result ? (result as { effects?: EffectEvidence }).effects : undefined;

type Outcome = { result: unknown; status: Call['status']; notes?: string[] };
interface Entry { call: Call; request: ToolRequest; args?: Record<string, unknown>; outcome?: Outcome }
interface Admitted extends Entry { args: Record<string, unknown> }

function executionOutcome(host: StepHost, call: Call, result: unknown, stopped: boolean): Outcome {
  if (backgroundOf(result)) return { result, status: 'running' };
  const started = host.store.call(call.id).effectState === 'started';
  const verified = evidenceOf(result)?.verified === true;
  let status: Call['status'] = stopped ? call.effect === 'write' && started && !verified ? 'unknown' : 'cancelled' : 'succeeded';
  if (['process.exec', 'process.run', 'shell.exec'].includes(call.name) && result && typeof result === 'object'
    && (('timedOut' in result && result.timedOut === true) || ('cancelled' in result && result.cancelled === true))) {
    status = call.effect === 'write' && started && !verified ? 'unknown' : 'timedOut' in result && result.timedOut === true ? 'failed' : 'cancelled';
  }
  if (result && typeof result === 'object' && 'effectUnknown' in result && result.effectUnknown === true && call.effect === 'write') status = 'unknown';
  return { result, status };
}

function executionFailure(host: StepHost, call: Call, error: unknown, stopped: boolean, aborted: boolean): Outcome {
  if (host.store.fault !== undefined) throw host.store.fault;
  const registered = host.tools.isRegistered(call.name);
  const notStarted = host.store.call(call.id).effectState === 'not_started' || (!registered && error instanceof KodoError && error.code === 'PROCESS_START');
  if (notStarted && error instanceof KodoError && ['LOCK_TIMEOUT', 'RESOURCE_WAIT_TIMEOUT'].includes(error.code)) return { status: 'failed', result: { error: errorText(error), notStarted: true } };
  const status = call.effect === 'write' && !notStarted && (registered || call.name === 'workspace.git' || stopped || !(error instanceof KodoError) || ['PROCESS_STOP', 'PROCESS_INPUT', 'SANDBOX_CLEANUP'].includes(error.code)) ? 'unknown' : registered && aborted ? 'cancelled' : 'failed';
  return { status, result: { error: stopped ? `TOOL_ABORTED: operation stopped; ${notStarted ? 'side effects not started' : 'inspect any possible side effects'}` : errorText(error), ...(notStarted ? { notStarted: true } : {}) } };
}

/** Validates one planned call and records its start; a KodoError becomes a failed tool result. */
async function admit(host: StepHost, run: Run, modelCall: Call, call: Call, request: ToolRequest, invalidBatch: boolean, signal: AbortSignal, notices: Message[]): Promise<Record<string, unknown>> {
  const { store } = host;
  const session = executionSession(store, run);
  run = effectiveMethodRun(store, store.run(run.id));
  if (run.toolChoice === 'none') throw new KodoError('TOOL_CHOICE', 'this host-created text generation task does not execute tools');
  if (invalidBatch) throw new KodoError('CONTROL_BATCH', 'entire tool batch rejected: at most one control call, in last position');
  if ((modelCall.decisionVersion ?? 0) !== (session.decisionVersion ?? 0)) throw new KodoError('DECISION_CHANGED', 'not executed: user constraints changed after this model request');
  const args = collaborationTool(request.name) ? host.mailbox.validate(run, request.name, request.arguments) : host.tools.validate(request.name, request.arguments, run.card.tools, effectiveSession(run, session), run);
  call.effect = host.tools.effect(request.name, args);
  const effectRoots = !internal(request.name) && call.effect === 'write' ? host.tools.effectRoots(run.id, request.name, args) : undefined;
  if (!collaborationTool(request.name)) assertTodoExecution(store, run, request.name, call.effect, effectRoots);
  if (!internal(request.name) && call.effect === 'write') {
    const instructions = store.transaction(() => beforeWriteInstructions(store, store.run(run.id), session, [request]));
    if (instructions) notices.push(instructions);
    if (notices.some(message => message.content?.startsWith('<kodo-context kind="project-instructions"'))) throw new KodoError('INSTRUCTIONS_CHANGED', 'not started: read the newly loaded project instructions and plan this write again');
  }
  if (effectRoots) host.tools.assertWriteScope(run.id, effectRoots);
  const hook = await host.hooks?.run('tool.before', { runId: run.id, data: { callId: call.id, name: request.name, arguments: args } }, signal);
  if (hook?.notes.length) notices.push(attachment('notice', hook.notes.join('\n')));
  if (hook?.denied) throw new KodoError('HOOK_DENIED', 'not started: the host rejected this tool call');
  store.transaction(() => {
    const latest = store.session(run.sessionId);
    signal.throwIfAborted();
    // Only explicit host caps stop tool execution; none are set by default.
    if ((latest.budget.maxToolCalls !== null && latest.toolCalls >= latest.budget.maxToolCalls) || (latest.budget.maxTokens !== null && latest.tokens > latest.budget.maxTokens)) throw new KodoError('TOOL_BUDGET', 'tool call or token budget exhausted');
    store.putSession({ ...latest, toolCalls: latest.toolCalls + 1 });
    store.putCall({ ...call, status: 'running', effectState: 'not_started', effectAtomic: internal(call.name), ...(effectRoots ? { effectRoots } : {}) });
    store.event(run.id, 'tool.started', { callId: call.id, name: call.name });
  });
  return args;
}

/** Executes an admitted call; returns the result and status to record (internal successes are already committed). */
async function execute(host: StepHost, run: Run, modelCall: Call, call: Call, request: ToolRequest, args: Record<string, unknown>, signal: AbortSignal, batchSignal?: AbortSignal): Promise<Outcome> {
  const { store } = host;
  const session = store.session(run.sessionId);
  const deferredTimeout = (session.taskProtocol ?? 1) >= 2 && !internal(request.name);
  const executionController = new AbortController();
  const resourceController = new AbortController();
  const timeout = deferredTimeout ? executionController.signal : AbortSignal.timeout(session.budget.toolTimeoutMs);
  let executionTimer: ReturnType<typeof setTimeout> | undefined;
  let resourceTimer: ReturnType<typeof setTimeout> | undefined;
  const stopQueued = (): void => { if (deferredTimeout && !executionTimer) resourceController.abort(signal.reason); };
  const onExecutionReady = (): void => {
    if (!deferredTimeout || executionTimer) return;
    resourceController.signal.throwIfAborted();
    clearTimeout(resourceTimer);
    executionTimer = setTimeout(() => executionController.abort(new DOMException('tool execution deadline exceeded', 'TimeoutError')), session.budget.toolTimeoutMs);
    store.event(run.id, 'tool.resource_ready', { callId: call.id });
  };
  if (deferredTimeout) {
    // Resource queues have their own finite ceiling; the shared run deadline and cancellation may stop them sooner.
    resourceTimer = setTimeout(() => resourceController.abort(new KodoError('RESOURCE_WAIT_TIMEOUT', 'resource acquisition exceeded ten minutes; the operation was not started')), 600_000);
    signal.addEventListener('abort', stopQueued, { once: true });
    if (signal.aborted) stopQueued();
  }
  const toolController = new AbortController();
  const controllers = host.toolControllers.get(run.id) ?? new Set<AbortController>();
  host.toolControllers.set(run.id, controllers.add(toolController));
  // Process and shell calls use the tool timeout as their foreground wait limit.
  const movable = request.name === 'process.exec' || request.name === 'shell.exec';
  const block = !internal(request.name) && host.tools.interrupt(request.name) === 'block';
  const toolSignal = AbortSignal.any([...(block ? [] : [signal]), ...(movable ? [] : [timeout]), ...(deferredTimeout ? [resourceController.signal] : []), toolController.signal, ...(batchSignal ? [batchSignal] : [])]);
  const stopped = (): boolean => toolSignal.aborted || (movable && timeout.aborted);
  let result: unknown;
  let status: Call['status'];
  let committed: Outcome | undefined;
  try {
    if (internal(request.name)) {
      store.transaction(() => {
        toolSignal.throwIfAborted();
        if (terminal(store.run(run.id).status)) throw new KodoError('CANCELLED', 'run ended before collaboration operation');
        if ((modelCall.decisionVersion ?? 0) !== (store.session(run.sessionId).decisionVersion ?? 0)) throw new KodoError('DECISION_CHANGED', 'user constraints changed before collaboration operation');
        result = collaborationTool(request.name) ? host.mailbox.execute(store.run(run.id), call.id, request.name, args) : host.tools.executeAtomic(run.id, request.name, args, toolSignal);
        const resultRef = store.blob(result);
        store.putCall({ ...call, status: 'succeeded', resultRef, effectState: 'started', effectAtomic: true, ...(call.effect === 'write' ? { effectOutcome: 'applied' } : {}) });
        store.event(run.id, 'tool.finished', { callId: call.id, name: call.name, status: 'succeeded', resultRef });
      });
    } else {
      assertTodoExecution(store, store.run(run.id), request.name, call.effect!, call.effectRoots);
      const runTool = (): Promise<unknown> => host.tools.execute(run.id, request.name, args, toolSignal, () => {
        toolSignal.throwIfAborted();
        store.putCall({ ...store.call(call.id), effectState: 'started' });
      }, { callId: call.id, ...(deferredTimeout ? { onExecutionReady } : {}), ...(movable ? { foreground: timeout } : {}), ...(call.effect === 'write' ? { settle: (settlement: { ok: true; result: unknown } | { ok: false; error: unknown }): void => {
        const outcome = settlement.ok ? executionOutcome(host, call, settlement.result, stopped()) : executionFailure(host, call, settlement.error, stopped(), toolSignal.aborted);
        // Publish the effect before Tools releases the lock. Hooks run only after this commit.
        record(host, run, call, outcome);
        committed = outcome;
      } } : {}) });
      // Host callbacks may ignore cancellation. Their IO keeps the Tools write lock
      // until it settles; this run records uncertainty and can stop promptly.
      result = host.tools.isRegistered(request.name) && !block ? await abortable(runTool, toolSignal) : await runTool();
    }
    const outcome = committed ?? executionOutcome(host, call, result, stopped());
    result = outcome.result;
    status = outcome.status;
  } catch (error) {
    if (store.fault) throw store.fault;
    const outcome = committed ?? executionFailure(host, call, error, stopped(), toolSignal.aborted);
    result = outcome.result;
    status = outcome.status;
  } finally {
    clearTimeout(executionTimer);
    clearTimeout(resourceTimer);
    signal.removeEventListener('abort', stopQueued);
    controllers.delete(toolController);
    if (!controllers.size && host.toolControllers.get(run.id) === controllers) host.toolControllers.delete(run.id);
  }
  const hook = await host.hooks?.run(status === 'succeeded' || status === 'running' ? 'tool.after' : 'tool.failed', { runId: run.id, data: { callId: call.id, name: request.name, status, result } });
  return { result: host.tools.boundResult(run.id, request.name, result), status, ...(hook?.notes.length ? { notes: hook.notes } : {}) };
}

/** Runs admitted read calls together; the first failed command stops the siblings still in flight. */
async function executeParallel(host: StepHost, run: Run, modelCall: Call, items: Admitted[], signal: AbortSignal): Promise<{ outcomes: Outcome[]; failedCommand?: string }> {
  const controller = new AbortController();
  let failedCommand: string | undefined;
  const outcomes = await Promise.all(items.map(async item => {
    const outcome = await execute(host, run, modelCall, item.call, item.request, item.args, signal, controller.signal);
    if (failedCommand === undefined && commandFailed(item.request.name, outcome)) {
      failedCommand = item.call.id;
      controller.abort(new KodoError('SIBLING_FAILED', `command ${item.call.id} failed in the same batch`));
      return outcome;
    }
    // A read that completed before the stop keeps its evidence.
    return failedCommand !== undefined && outcome.status !== 'succeeded' ? siblingStopped(failedCommand) : outcome;
  }));
  return { outcomes, ...(failedCommand === undefined ? {} : { failedCommand }) };
}

/**
 * Records a call's final outcome with any reconciliation evidence of a stopped process.
 * A background handle leaves the call running; a process that already settled keeps its recorded outcome.
 */
function record(host: StepHost, run: Run, call: Call, outcome: Outcome): void {
  const { store } = host;
  // A callback that ignored cancellation may settle after stop convergence.
  // Its terminal source and unknown call remain immutable for audited recovery.
  if (terminal(store.run(run.id).status)) return;
  store.transaction(() => {
    const result = outcome.status === 'succeeded' ? recordMethodLoad(store, store.run(run.id), call, outcome.result) : outcome.result;
    const resultRef = store.blob(result);
    const background = backgroundOf(outcome.result);
    if (background) {
      const current = store.call(call.id);
      if (current.status === 'running') store.putCall({ ...current, resultRef });
      store.event(run.id, 'tool.finished', { callId: call.id, name: call.name, status: current.status, resultRef, background: background.id });
      return;
    }
    const current = store.call(call.id);
    if (current.status === outcome.status && current.resultRef === resultRef) return;
    const evidence = evidenceOf(outcome.result);
    const effectOutcome = current.effect === 'write' ? evidence?.verified ? evidence.outcome : outcome.status === 'unknown' ? 'unknown' : current.effectState !== 'started' ? 'not_applied' : outcome.status === 'succeeded' ? 'applied' : undefined : undefined;
    store.putCall({ ...current, status: outcome.status, resultRef, ...(effectOutcome ? { effectOutcome } : {}) });
    store.event(run.id, 'tool.finished', { callId: call.id, name: call.name, status: outcome.status, resultRef });
    if (evidence) store.event(run.id, 'tool.reconciled', reconciledEvent(call.id, evidence));
  });
}

/** Tool results in request order; native image results carry their attachment. */
function resultMessages(host: StepHost, modelCall: Call, requests: ToolRequest[], profile?: string): Message[] {
  return requests.map((request): Message => {
    const call = host.store.call(`${modelCall.id}:${request.id}`);
    const original = host.store.readBlob<unknown>(call.modelResultRef ?? call.resultRef!);
    const value = call.modelResultRef ? original : host.tools.boundResult(call.runId, call.name, original);
    if (!call.modelResultRef && value !== original) host.store.putCall({ ...call, modelResultRef: host.store.blob(value) });
    // Native tool identity is reserved by Tools; image-shaped extension output is plain data.
    if (call.name === 'image.read' && call.status === 'succeeded') {
      if (!value || typeof value !== 'object' || !('image' in value)) throw new KodoError('MODEL_PROTOCOL', 'native image result is missing its attachment');
      const { image, ...metadata } = value as Record<string, unknown> & { image: ImageInput };
      validateImageInput(image);
      return { role: 'tool', tool_call_id: request.id, content: JSON.stringify(metadata), images: [image] };
    }
    return { role: 'tool', tool_call_id: request.id, content: JSON.stringify(viewResult(profile, value)) };
  });
}

/** Advisory runtime feedback after a tool batch: corrections, re-read and repeat notices, nudges. */
function feedback(host: StepHost, run: Run, modelCall: Call, requests: ToolRequest[], repeats: Map<string, number>, changed: string[]): { messages: Message[]; nudge?: { readCalls: number } } {
  const { store } = host;
  const messages: Message[] = [];
  if (changed.length) {
    messages.push(attachment('changed-files', changedFilesNotice(changed)));
    store.event(run.id, 'files.changed', { paths: changed, step: run.step });
  }
  const correctablePathFailure = requests.some(request => {
    const call = store.call(`${modelCall.id}:${request.id}`);
    if (call.effect !== 'write' || call.status !== 'failed' || call.effectState !== 'not_started' || !call.resultRef) return false;
    return store.readBlob<{ error?: string }>(call.resultRef).error?.startsWith('PATH_DENIED:') === true;
  });
  if (correctablePathFailure) messages.push(attachment('notice', 'Runtime save correction: the failed write did not start. Reuse the existing tool arguments and body from the immediately preceding assistant message, change only the invalid path or other rejected parameter as directed by the tool error, then save and confirm the result. Do not repeat project exploration. This is execution guidance, not permission to widen scope.'));
  const reread = repeatedReads(store, run.id, new Set(requests.map(request => `${modelCall.id}:${request.id}`)));
  if (reread.length) {
    messages.push(attachment('notice', rereadNotice(reread)));
    store.event(run.id, 'tool.reread_warning', { paths: reread, step: run.step });
  }
  const session = store.session(run.sessionId);
  const progress = run.card.nudges === true ? writeNudge(store, run.id, effectiveSession(run, session).permissions.includes('write')) : undefined;
  if (progress) {
    messages.push(attachment('nudge', progress.text));
    store.event(run.id, 'progress.write_nudged', { readCalls: progress.readCalls, step: run.step });
  }
  for (const [name, count] of repeats) messages.push(attachment('notice', repeatNotice(name, count)));
  // A pending wait means the run already delegated or is blocked; the nudge only targets active direct reading.
  const nudge = host.exploreNudge !== false && !store.run(run.id).waitId && host.mailbox.specs(run).some(spec => spec.name === 'explore') ? exploreNudge(store, run, host.exploreNudge) : undefined;
  if (nudge) messages.push(attachment('nudge', nudge.text));
  return { messages, ...(nudge ? { nudge } : {}) };
}
/**
 * Executes the tool calls of a persisted model response, records every result,
 * appends advisory feedback and advances the step. Repeats only advise until the
 * no-progress breaker: 12 identical call+result repeats, or 6 consecutive model
 * responses that were blank or had only failed tool calls.
 */
export async function runToolStep(host: StepHost, run: Run, modelCall: Call, response: ModelResponse, signal: AbortSignal): Promise<StepOutcome> {
  const { store } = host;
  // Every decision below reads canonical kernel calls; results still answer the model's call IDs.
  const viewSession = effectiveSession(run, store.session(run.sessionId));
  const resolved = (response.message.tool_calls ?? []).map(request => canonicalRequest(run, viewSession, request));
  const requests = resolved.map(item => item.request);
  const viewErrors = new Map(resolved.flatMap(item => item.error ? [[item.request.id, item.error] as const] : []));
  for (const [id, error] of responseSpawnWriteConflicts(host, run, requests)) viewErrors.set(id, error);
  const controls = requests.filter(x => {
    try { return controlTool(x.name, JSON.parse(x.arguments) as Record<string, unknown>); }
    catch { return controlTool(x.name); }
  });
  const invalidBatch = controls.length > 1 || (controls.length === 1 && requests.at(-1) !== controls[0]);
  const repeats = new Map<string, number>();
  const notices: Message[] = [];
  const safe = (request: ToolRequest): boolean => {
    if (invalidBatch || viewErrors.has(request.id) || internal(request.name) || request.name === 'todo.write') return false;
    try {
      const args = host.tools.validate(request.name, request.arguments, run.card.tools, effectiveSession(run, store.session(run.sessionId)), run);
      return host.tools.effect(request.name, args) === 'read' && host.tools.concurrencySafe(request.name, args);
    } catch (error) { if (error instanceof KodoError) return false; throw error; }
  };
  for (const batch of toolBatches(requests, safe)) {
    signal.throwIfAborted();
    const entries: Entry[] = [];
    let budgetFailure: StepOutcome | undefined;
    for (const request of batch) {
      const call = store.call(`${modelCall.id}:${request.id}`);
      if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(call.status)) {
        // Unknown effects are never replayed; their scope remains blocked, but this run can continue elsewhere.
        if (call.status === 'unknown' && !call.resultRef) record(host, run, call, { status: 'unknown', result: { error: 'UNKNOWN_WRITE: effect is unsettled; only overlapping writes are blocked', roots: call.effectRoots } });
        continue;
      }
      if (call.status !== 'planned') throw new KodoError('UNKNOWN_WRITE', 'call is not confirmed safe to execute');
      try {
        const viewError = viewErrors.get(request.id);
        if (viewError) throw viewError;
        entries.push({ call, request, args: await admit(host, run, modelCall, call, request, invalidBatch, signal, notices) });
      }
      catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof KodoError && error.code === 'TOOL_BUDGET') { budgetFailure = { kind: 'fail', error: errorText(error) }; break; }
        if (store.fault) throw store.fault;
        const hint = error instanceof KodoError && error.code === 'TOOL_ARGUMENTS' && error.message.includes('/expectedHash') ? await host.tools.expectedHashHint(run.id, request.name, request.arguments, signal) : undefined;
        const hook = await host.hooks?.run('tool.failed', { runId: run.id, data: { callId: call.id, name: request.name, error: errorText(error), notStarted: true } }, signal);
        if (hook?.notes.length) notices.push(attachment('notice', hook.notes.join('\n')));
        entries.push({ call, request, outcome: { result: { error: hint ? `${errorText(error)}; ${hint}` : errorText(error), notStarted: true }, status: 'failed' } });
      }
    }
    const runnable = entries.filter((entry): entry is Admitted => entry.args !== undefined);
    if (runnable.length > 1) {
      const parallel = await executeParallel(host, run, modelCall, runnable, signal);
      runnable.forEach((entry, index) => { entry.outcome = parallel.outcomes[index]; });
    } else for (const entry of runnable) entry.outcome = await execute(host, run, modelCall, entry.call, entry.request, entry.args, signal);
    let stop: StepOutcome | undefined = budgetFailure;
    for (const entry of entries) {
      if (entry.outcome?.notes?.length) notices.push(attachment('notice', entry.outcome.notes.join('\n')));
      // A committed internal operation has a known result even if a post-commit listener cancels the run.
      if (internal(entry.request.name) && store.call(entry.call.id).status === 'succeeded') continue;
      record(host, run, entry.call, entry.outcome!);
      if (entry.outcome!.status === 'unknown') notices.push(attachment('notice', `Call ${entry.call.id} has an unknown write outcome. Do not repeat it. Use recovery.inspect to request host verification. Overlapping writes remain blocked; independent reads and other write ranges can continue. If verification remains unavailable, report the blocked call and required host evidence.`));
      const streak = identicalStreak(store, run.id);
      if (streak && streak.count >= repeatBreakerAt) stop ??= handoffFailure(store, run, 'NO_PROGRESS', `${streak.name} returned the same result for the same arguments ${streak.count} times in a row`);
      else if (streak && repeatNoticeAt.includes(streak.count)) {
        repeats.set(streak.name, streak.count);
        store.event(run.id, 'tool.repetition_warning', { name: streak.name, consecutive: streak.count });
      }
    }
    signal.throwIfAborted();
    if (stop) return stop;
  }
  let reconciled = false;
  const onlyBlockedWrites = requests.length > 0 && requests.every(request => {
    const call = store.call(`${modelCall.id}:${request.id}`);
    if (call.status !== 'failed' || !call.resultRef) return false;
    const result = store.readBlob<{ error?: string }>(call.resultRef);
    return result.error?.startsWith('UNKNOWN_WRITE:');
  });
  if (onlyBlockedWrites) {
    let reason = '';
    try {
      if (store.unresolvedWrites(store.session(run.sessionId).workspace).some(call => call.runId === run.id)) {
        const plan = await host.recovery.inspect(run.id, signal);
        reason = plan.observations.map(item => `${item.callId}: ${item.evidence}`).join('; ');
      }
    } catch (error) {
      if (signal.aborted || store.fault) throw error;
      reason = errorText(error);
    }
    const blocked = store.unresolvedWrites(store.session(run.sessionId).workspace);
    if (blocked.length) return handoffFailure(store, run, 'UNKNOWN_WRITE', `host verification is required for ${blocked.map(call => call.id).join(', ')}; ${reason || 'the unresolved effects belong to another run'}. Blocked writes were not repeated`);
    reconciled = true;
    notices.push(attachment('notice', `Host verification resolved the write barrier. ${reason} Review the recorded outcomes before continuing; blocked calls were not executed or replayed.`));
  }
  const failedSteps = failedStepStreak(store, run.id);
  if (!reconciled && failedSteps >= failedStepBreakerAt) return handoffFailure(store, run, 'NO_PROGRESS', `${failedSteps} consecutive model responses produced only failed tool calls or no output`);
  // Files this run saw that changed by other means are reported once per new content.
  const changed = await changedSinceSeen(store, run.id, runWorkspace(store, run), signal);
  const settled = backgroundNotice(store, run.id);
  if (settled.unknown) notices.push(attachment('notice', backgroundUnknown));
  const extra = feedback(host, run, modelCall, requests, repeats, changed);
  if (settled.message) extra.messages.unshift(settled.message);
  // Instruction files reached by this batch follow its results, before advisory feedback.
  const touched = store.transaction(() => touchedInstructions(store, store.run(run.id), executionSession(store, store.run(run.id)), requests.map(request => ({ request, succeeded: store.call(`${modelCall.id}:${request.id}`).status === 'succeeded' }))));
  // Lean views name tools as advertised; only runtime-authored text is rewritten.
  const profile = !run.parentId && isLeanProfile(store.session(run.sessionId).toolProfile) ? store.session(run.sessionId).toolProfile : undefined;
  const attachments = orderAttachments([...notices, ...(touched ? [touched] : []), ...extra.messages]).map(message => profile && typeof message.content === 'string' ? { ...message, content: viewText(profile, message.content) } : message);
  const context = [...store.readBlob<Message[]>(run.contextRef), response.message, ...resultMessages(host, modelCall, requests, profile), ...attachments];
  const contextRef = store.blob(context);
  store.transaction(() => {
    const latest = store.run(run.id);
    if (!terminal(latest.status) && latest.status !== 'interrupted') {
      store.updateRun(run.id, { contextRef, stepCallId: undefined, step: run.step + 1 });
      markReported(store, run.id, settled.ids);
      if (extra.nudge) store.event(run.id, 'delegation.nudged', { readCalls: extra.nudge.readCalls, threshold: host.exploreNudge, step: run.step });
    }
  });
  const waitId = store.run(run.id).waitId;
  return waitId ? { kind: 'wait', waitId } : { kind: 'continue' };
}
