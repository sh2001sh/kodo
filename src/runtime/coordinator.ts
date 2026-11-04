import { Store } from '../storage/index.js';
import { Tools } from '../tools/index.js';
import { assertRunCapabilities } from '../tools/bindings.js';
import type { ReadOnlyCommand } from '../tools/index.js';
import type { SandboxPolicy } from '../sandbox/index.js';
import { collaborationTool, Mailbox } from '../messaging/index.js';
import { errorText, KodoError, terminal } from './types.js';
import type { CancelOrigin } from './types.js';
import type { AssemblyPolicy, CompactionPolicy } from './context.js';
import { inspectContext } from './context-inspection.js';
import { RecoveryManager } from './recovery.js';
import { checkCompletion, unresolvedCompletionWrites, workspaceWrites } from './completion.js';
import { childCompletionState } from './child-completion.js';
import { runModelStep } from './model-step.js';
import { toolSpecs } from './step-host.js';
import type { StepHost } from './step-host.js';
import { runToolStep } from './tool-step.js';
import { settleBackground } from './background-notice.js';
import { attachment } from './attachments.js';
import { HostHooks } from './hooks.js';
import type { HookRegistration } from './hooks.js';
import { turnEndDelivery } from './turn-end.js';
import type { CompletionValidator, Message, ModelBinding, ModelResponse, Provider, Run, StepOutcome } from './types.js';
import type { ProjectKnowledge } from '../knowledge/index.js';

export { runBudget } from './run-budget.js';

export class RunCoordinator implements StepHost {
  private active = new Map<string, { controller: AbortController; promise: Promise<Run> }>();
  private drivers = new Map<string, Promise<Run>>();
  private readonly stopping = new Map<string, Promise<Run>>();
  private storageFailure: unknown;
  readonly hooks: HostHooks;
  readonly tools: Tools;
  readonly mailbox: Mailbox;
  readonly recovery: RecoveryManager;
  readonly knowledge?: ProjectKnowledge;
  readonly compaction?: CompactionPolicy;
  readonly assembly?: AssemblyPolicy;
  private modelCounts = new Map<string, number>();
  private modelQueue: { run: Run; start: () => void }[] = [];
  readonly toolControllers = new Map<string, Set<AbortController>>();
  readonly completionValidators = new Map<string, CompletionValidator>();
  private sessionClocks = new Map<string, { lastAt: number; count: number; timer?: ReturnType<typeof setTimeout> }>();
  constructor(readonly store: Store, readonly provider: Provider, private readonly textListener: (runId: string, text: string) => void = () => {}, readOnlyCommands: ReadOnlyCommand[] = [], options: { modelBindings?: Record<string, ModelBinding>; sandbox?: SandboxPolicy; shellProgram?: string; knowledge?: ProjectKnowledge; compaction?: CompactionPolicy; assembly?: AssemblyPolicy; globalInstructions?: string | false; lockDirectory?: string | false; hooks?: readonly HookRegistration[]; lazyTools?: boolean } = {}) {
    this.knowledge = options.knowledge;
    this.hooks = new HostHooks(store, options.hooks);
    this.compaction = options.compaction;
    this.assembly = options.assembly;
    this.tools = new Tools(store, readOnlyCommands, { sandbox: options.sandbox, shellProgram: options.shellProgram, lazyTools: options.lazyTools, ...(options.lockDirectory === undefined ? {} : { lockDirectory: options.lockDirectory }), inspectRecovery: async (runId, signal) => {
      const run = store.run(runId);
      const pending = store.unresolvedWrites(store.session(run.sessionId).workspace);
      const plan = pending.some(call => call.runId === runId) ? await this.recovery.inspect(runId, signal) : { sourceRunId: runId, blocked: [] as string[], observations: [] as { callId: string; evidence: string }[] };
      const others = pending.filter(call => call.runId !== runId);
      return { sourceRunId: runId, blocked: [...plan.blocked, ...others.map(call => call.id)], observations: [...plan.observations, ...others.map(call => ({ callId: call.id, evidence: 'This effect belongs to another run; its owner or host must verify it.' }))] };
    } });
    this.mailbox = new Mailbox(store, (id, origin) => this.cancel(id, origin), {
      modelBindings: options.modelBindings, bindingSnapshot: (allowed, skillIds) => this.tools.bindingSnapshot(allowed, skillIds),
      globalInstructions: options.globalInstructions,
    });
    this.recovery = new RecoveryManager(store, this.tools);
    store.onFault(error => this.stopForStorageFault(error));
  }
  setCompletionValidator(runId: string, validator: CompletionValidator): void {
    const run = this.store.run(runId);
    if (terminal(run.status)) {
      if (run.requiresValidation && run.status === 'failed' && run.error?.startsWith('UNKNOWN_WRITE:')) {
        // Reattach host code for an audited recovery continuation without changing the terminal source.
        this.completionValidators.set(runId, validator);
        return;
      }
      throw new KodoError('RUN_ENDED', 'attach a completion validator before the run ends');
    }
    this.completionValidators.set(runId, validator);
    this.store.updateRun(runId, { requiresValidation: true });
  }
  wake(runId: string): Promise<Run> {
    this.assertHealthy();
    const existing = this.active.get(runId);
    if (existing) return this.afterStop(runId, existing.promise);
    const run = this.store.run(runId);
    if (this.stopping.has(runId)) return this.waitForStop(runId);
    if (terminal(run.status)) return Promise.resolve(run);
    if (run.cancelRequested) { this.beginStop(runId, 'cancelled'); return this.waitForStop(runId); }
    if (run.continuationOf && !this.continuationReady(run)) return Promise.resolve(run);
    if (run.status === 'interrupted') throw new KodoError('RECOVERY_REQUIRED', 'inspect and explicitly resume this interrupted run');
    if (run.status === 'waiting') {
      this.store.transaction(() => this.mailbox.refresh(runId));
      if (this.store.run(runId).status === 'waiting') return Promise.resolve(this.store.run(runId));
    }
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => this.advance(runId, controller)).finally(() => {
      this.active.delete(runId);
      if (this.storageFailure !== undefined) return;
      const stopped = this.store.run(runId);
      const before = Number(this.store.latestEvent(runId, { types: ['run.interrupt_requested'] })?.data.inputSeq ?? stopped.inputCursor ?? 0);
      if (stopped.interruptRequested && this.store.inbox(runId).some(message => message.seq > before)) this.resumeInterrupted(runId);
    });
    this.active.set(runId, { controller, promise });
    // Reserve scheduling ownership before another queued sibling is admitted in
    // this synchronous drive pass; advance starts in the next microtask.
    if (this.store.run(runId).status === 'queued') this.store.updateRun(runId, { status: 'running' });
    return this.afterStop(runId, promise);
  }
  /** Public wake results include stop convergence; active.promise remains the raw executor to avoid a circular wait. */
  private async afterStop(runId: string, execution: Promise<Run>): Promise<Run> {
    const result = await execution;
    if (this.storageFailure !== undefined) return result;
    // No extra await/read when nothing is stopping: a driver may close the store
    // as soon as the raw executor settles. Stop jobs return their own durable snapshot.
    return this.stopping.get(runId) ?? result;
  }
  /** Request cancellation now; terminal state follows stopped/reconciled effects, within five seconds. */
  cancel(runId: string, origin: CancelOrigin = { initiator: 'user' }): void {
    this.assertHealthy();
    const run = this.store.run(runId);
    if (terminal(run.status) || run.cancelRequested) return;
    this.store.transaction(() => {
      this.store.updateRun(runId, { cancelRequested: true, interruptRequested: false });
      this.store.event(runId, 'run.cancel_requested', { ...origin });
      for (const child of this.store.listRuns(run.sessionId)) if (child.parentId === runId && !terminal(child.status)) this.cancel(child.id, { initiator: 'parent', by: runId });
    });
    this.beginStop(runId, 'cancelled', origin);
  }
  /** Interrupt only this turn; no descendants are cancelled and the context stays resumable. */
  interrupt(runId: string): void {
    this.assertHealthy();
    const run = this.store.run(runId);
    if (terminal(run.status) || run.cancelRequested || run.interruptRequested) return;
    this.store.updateRun(runId, { interruptRequested: true });
    this.store.event(runId, 'run.interrupt_requested', { inputSeq: this.store.inbox(runId).at(-1)?.seq ?? run.inputCursor ?? 0 });
    this.beginStop(runId, 'interrupted');
  }
  waitForStop(runId: string): Promise<Run> {
    this.assertHealthy();
    return this.stopping.get(runId) ?? Promise.resolve(this.store.run(runId));
  }
  /** New input restarts an intentionally interrupted turn, never a fault-interrupted run. */
  resumeInterrupted(runId: string): void {
    const run = this.store.run(runId);
    if (!run.interruptRequested || run.cancelRequested || run.status !== 'interrupted' || this.stopping.has(runId) || this.active.has(runId)) return;
    this.store.updateRun(runId, { status: 'queued', interruptRequested: false, error: undefined });
    this.store.event(runId, 'run.queued', { reason: 'new input after turn interruption' });
  }
  private beginStop(runId: string, status: 'cancelled' | 'interrupted', origin?: CancelOrigin): void {
    const active = this.active.get(runId);
    const source = this.store.run(runId);
    const inputBeforeStop = this.store.inbox(runId).at(-1)?.seq ?? this.store.run(runId).inputCursor ?? 0;
    const reason = new KodoError(status === 'cancelled' ? 'CANCELLED' : 'TURN_INTERRUPTED', status === 'cancelled' ? `${origin?.initiator ?? 'user'} cancelled` : 'current turn interrupted');
    active?.controller.abort(reason);
    // Ordinary tools follow the run signal; interrupt:block tools deliberately finish their admitted operation.
    const finish = (): void => {
      if (this.storageFailure !== undefined) return;
      this.finishStop(runId, this.store.run(runId).cancelRequested ? 'cancelled' : status, origin);
    };
    const childStops = status === 'cancelled' ? this.store.listRuns(this.store.run(runId).sessionId).filter(child => child.parentId === runId).flatMap(child => this.stopping.get(child.id) ?? []) : [];
    if (!active && !childStops.length && !this.tools.backgroundRunning(runId) && !this.tools.hasInFlightEffects(runId)) { finish(); return; }
    if (this.stopping.has(runId)) return;
    const done = (async (): Promise<Run> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all([active?.promise, ...childStops, this.tools.stopBackground(runId, reason.message, false)]),
          new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); }),
        ]);
        finish();
      } catch (error) {
        if (this.store.fault !== undefined) this.stopForStorageFault(error);
        else { this.store.event(runId, 'run.stop_failed', { error: errorText(error) }); finish(); }
      } finally {
        clearTimeout(timer); this.stopping.delete(runId);
        if (this.storageFailure === undefined && status === 'interrupted' && this.store.inbox(runId).some(message => message.seq > inputBeforeStop)) this.resumeInterrupted(runId);
      }
      return this.storageFailure !== undefined ? { ...source, status: 'interrupted', error: `STORAGE_FAULT: ${errorText(this.storageFailure)}` } : this.store.run(runId);
    })();
    this.stopping.set(runId, done);
  }
  private finishStop(runId: string, status: 'cancelled' | 'interrupted', origin?: CancelOrigin): void {
    this.store.transaction(() => {
      const run = this.store.run(runId);
      if (terminal(run.status)) return;
      const calls = this.store.calls(runId);
      for (const call of calls) if (call.status === 'running' || call.status === 'planned') {
        if (call.kind === 'model') {
          this.store.putCall({ ...call, status: 'cancelled', resultRef: this.store.blob({ error: 'MODEL_INTERRUPTED: the current turn stopped; any unreported usage reservation is retained' }) });
          this.store.putSession({ ...this.store.session(run.sessionId), usageEstimated: true });
        } else {
          const uncertain = call.status === 'running' && call.effect === 'write' && call.effectState !== 'not_started' && !call.effectAtomic;
          this.store.putCall({ ...call, status: uncertain ? 'unknown' : 'cancelled', effectOutcome: uncertain ? 'unknown' : 'not_applied', resultRef: this.store.blob({ error: uncertain ? 'UNKNOWN_WRITE: stop deadline reached; only overlapping writes are blocked until reconciliation' : 'TURN_STOPPED: this call did not finish; it will not be replayed', ...(!uncertain ? { notStarted: call.effectState === 'not_started' || call.status === 'planned' } : {}) }) });
        }
      }
      // A persisted assistant tool round must be paired even if interruption cut it short.
      const pending = run.stepCallId ? this.store.call(run.stepCallId) : undefined;
      const response = pending?.status === 'succeeded' && pending.resultRef ? this.store.readBlob<ModelResponse>(pending.resultRef) : undefined;
      let contextRef = run.contextRef;
      if (response) {
        const messages = this.store.readBlob<Message[]>(run.contextRef);
        messages.push(response.message);
        for (const request of response.message.tool_calls ?? []) {
          const call = this.store.call(`${pending!.id}:${request.id}`);
          messages.push({ role: 'tool', tool_call_id: request.id, content: call.resultRef ? JSON.stringify(this.store.readBlob(call.resultRef)) : JSON.stringify({ error: 'TURN_STOPPED: not executed', notStarted: true }) });
        }
        messages.push(attachment('notice', `${status === 'cancelled' ? 'Run cancelled' : 'Current turn interrupted'}. Recorded tool results are retained and will not be replayed.`));
        contextRef = this.store.blob(messages);
      }
      const unresolved = this.store.calls(runId).filter(call => call.status === 'unknown').map(call => ({ callId: call.id, roots: call.effectRoots }));
      this.store.updateRun(runId, { status, contextRef, stepCallId: undefined, step: run.step + Number(Boolean(response)), error: status === 'interrupted' ? 'TURN_INTERRUPTED: awaiting new input' : undefined });
      this.store.event(runId, `run.${status}`, { ...origin, unresolved, reconciled: unresolved.length === 0 });
      this.mailbox.onTerminal(runId);
    });
  }
  private assertHealthy(): void { if (this.storageFailure !== undefined || this.store.fault !== undefined) throw this.storageFailure ?? this.store.fault; }
  /** Storage faults stop execution in memory; they never depend on another database commit. */
  private stopForStorageFault(error: unknown): void {
    if (this.storageFailure !== undefined) return;
    this.storageFailure = error;
    for (const clock of this.sessionClocks.values()) clearTimeout(clock.timer);
    for (const active of this.active.values()) active.controller.abort(error);
    for (const controllers of this.toolControllers.values()) for (const controller of controllers) controller.abort(error);
    void this.tools.stopForStorageFault(error).catch(() => { /* The original storage fault remains the reported cause. */ });
  }
  /** Drive peers until this run ends or the session needs user input. Durable state is authoritative. */
  drive(runId: string): Promise<Run> {
    const existing = this.drivers.get(runId);
    if (existing) return existing;
    const promise = this.driveSession(runId).finally(() => { this.drivers.delete(runId); });
    this.drivers.set(runId, promise);
    return promise;
  }
  private async driveSession(runId: string): Promise<Run> {
    const sessionId = this.store.run(runId).sessionId;
    let changed: (() => void) | undefined;
    const unsubscribe = this.store.subscribe(event => { if (event.sessionId === sessionId) changed?.(); });
    try {
      for (;;) {
        if (this.storageFailure !== undefined) return { ...this.store.run(runId), status: 'interrupted', error: `STORAGE_FAULT: ${errorText(this.storageFailure)}` };
        const notification = new Promise<void>(resolve => { changed = resolve; });
        // A run can leave `active` after the pass below saw it busy and without a further event; waiting on it
        // makes that exit start another pass, so a settled task child is always observed.
        const observed = [...this.active.entries()].filter(([id]) => this.store.run(id).sessionId === sessionId).map(([, x]) => x.promise);
        this.mailbox.refreshAll(sessionId);
        let target = this.store.run(runId);
        if (terminal(target.status) || target.status === 'interrupted') {
          await Promise.all([...this.stopping.entries()].filter(([id]) => this.store.run(id).sessionId === sessionId).map(([, promise]) => promise));
          if (!target.parentId && terminal(target.status) && !this.store.hasEvent(runId, { types: ['session.ended'] })) {
            const endedHook = await this.hooks.run('session.end', { runId, data: { status: target.status } });
            this.store.transaction(() => {
              const current = this.store.run(runId);
              const resultRef = endedHook.notes.length ? this.withHostNotes(current.resultRef, 'session.end', endedHook.notes, { status: current.status, error: current.error }) : current.resultRef;
              if (resultRef !== current.resultRef) this.store.updateRun(runId, { resultRef });
              this.store.event(runId, 'session.ended', { status: current.status, ...(resultRef ? { resultRef } : {}) });
            });
          }
          return this.store.run(runId);
        }
        for (const run of this.store.listRuns(sessionId)) if (run.status === 'queued' && !run.cancelRequested && !run.interruptRequested && this.continuationReady(run)) void this.wake(run.id);
        const active = [...this.active.entries()].filter(([id]) => this.store.run(id).sessionId === sessionId).map(([, x]) => x.promise);
        target = this.store.run(runId);
        if (!active.length && this.mailbox.userQuestions(sessionId).length) return target;
        const waits = this.store.waits(sessionId, true).filter(x => this.store.run(x.runId).waitId === x.id && this.store.run(x.runId).sessionId === sessionId && !terminal(this.store.run(x.runId).status) && this.store.run(x.runId).status !== 'interrupted');
        const stopping = [...this.stopping.values()];
        if (!active.length && !waits.length && !stopping.length) return target;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>(resolve => {
          if (waits.length) timer = setTimeout(resolve, Math.max(0, Math.min(...waits.map(x => x.deadline)) - Date.now()));
        });
        try { await Promise.race([notification, timeout, ...active, ...observed, ...stopping]); }
        finally { clearTimeout(timer); }
      }
    } finally { unsubscribe(); }
  }
  async shutdown(): Promise<void> {
    if (this.storageFailure !== undefined) {
      await Promise.allSettled([this.tools.stopForStorageFault(this.storageFailure)]);
      return;
    }
    for (const id of this.drivers.keys()) this.cancel(id, { initiator: 'shutdown' });
    for (const id of this.active.keys()) this.cancel(id, { initiator: 'shutdown' });
    await Promise.all([...this.stopping.values(), ...this.drivers.values()]);
    await this.tools.stopAllBackground('runtime shutdown');
  }
  get busy(): boolean { return this.active.size > 0 || this.drivers.size > 0 || this.stopping.size > 0; }
  private continuationReady(run: Run): boolean {
    if (!run.continuationOf) return true;
    const source = this.store.run(run.continuationOf);
    return terminal(source.status);
  }
  revokeSession(sessionId: string): void {
    for (const [id, controllers] of this.toolControllers) if (this.store.run(id).sessionId === sessionId) for (const controller of controllers) controller.abort(new KodoError('PERMISSIONS_REVOKED', 'user changed effective permissions'));
    for (const [id, active] of this.active) if (this.store.run(id).sessionId === sessionId) active.controller.abort(new KodoError('PERMISSIONS_REVOKED', 'user changed effective permissions'));
  }
  private startClock(sessionId: string): () => void {
    this.checkpointClock(sessionId);
    let clock = this.sessionClocks.get(sessionId);
    if (!clock) {
      const session = this.store.session(sessionId);
      const abort = (): void => {
        for (const [id, active] of this.active) if (this.store.run(id).sessionId === sessionId) active.controller.abort(new KodoError('TIME_BUDGET', 'shared session execution time exhausted'));
      };
      clock = { lastAt: Date.now(), count: 0 };
      const remaining = (): number | undefined => {
        const latest = this.store.session(sessionId);
        return latest.budget.maxDurationMs === null ? undefined : latest.budget.maxDurationMs - (latest.activeMs ?? 0);
      };
      // Node clamps oversized timers to 1 ms. Re-arm long explicit deadlines in bounded slices.
      const arm = (): void => {
        this.checkpointClock(sessionId);
        const left = remaining();
        if (left !== undefined) {
          if (left <= 0) abort();
          else clock!.timer = setTimeout(arm, Math.min(left, 2_147_483_647));
        }
      };
      this.store.putSession({ ...session, activeSince: clock.lastAt });
      this.sessionClocks.set(sessionId, clock);
      arm();
    }
    clock.count++;
    return () => {
      if (this.storageFailure !== undefined) { clearTimeout(clock.timer); this.sessionClocks.delete(sessionId); return; }
      this.checkpointClock(sessionId);
      clock.count--;
      if (!clock.count) {
        clearTimeout(clock.timer);
        this.sessionClocks.delete(sessionId);
        this.store.putSession({ ...this.store.session(sessionId), activeSince: undefined });
      }
    };
  }
  private checkpointClock(sessionId: string): void {
    if (this.storageFailure !== undefined) return;
    const clock = this.sessionClocks.get(sessionId);
    if (!clock) return;
    const now = Date.now();
    const session = this.store.session(sessionId);
    this.store.putSession({ ...session, activeMs: (session.activeMs ?? 0) + Math.max(0, now - clock.lastAt), activeSince: now });
    clock.lastAt = now;
  }
  acquireModel(run: Run, signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const entry = { run, start: (): void => {
        signal.removeEventListener('abort', abort);
        this.modelCounts.set(run.sessionId, (this.modelCounts.get(run.sessionId) ?? 0) + 1);
        resolve(() => {
          this.modelCounts.set(run.sessionId, this.modelCounts.get(run.sessionId)! - 1);
          const candidates = this.modelQueue.filter(x => x.run.sessionId === run.sessionId).sort((a, b) => Number(Boolean(a.run.parentId)) - Number(Boolean(b.run.parentId)));
          const next = candidates[0];
          if (next) { this.modelQueue.splice(this.modelQueue.indexOf(next), 1); next.start(); }
        });
      } };
      const abort = (): void => {
        const index = this.modelQueue.indexOf(entry);
        if (index >= 0) this.modelQueue.splice(index, 1);
        reject(signal.reason);
      };
      if (signal.aborted) { reject(signal.reason); return; }
      if ((this.modelCounts.get(run.sessionId) ?? 0) < this.store.session(run.sessionId).budget.maxConcurrentModels) entry.start();
      else { this.modelQueue.push(entry); signal.addEventListener('abort', abort, { once: true }); }
    });
  }
  /** Explicit host pause; storage faults use the in-memory fail-stop path instead. */
  suspendPeers(sourceId: string): void {
    const source = this.store.run(sourceId);
    for (const peer of this.store.listRuns(source.sessionId)) if (peer.id !== sourceId && !terminal(peer.status)) this.interrupt(peer.id);
  }
  resume(runId: string): Promise<Run> {
    this.prepareResume(runId);
    return this.wake(runId);
  }
  prepareResume(runId: string): void {
    const run = this.store.run(runId);
    if (run.status !== 'interrupted') throw new KodoError('NOT_INTERRUPTED', 'only interrupted runs can be resumed; terminal records remain immutable');
    this.classifyRecovery(runId);
    this.store.transaction(() => {
      const pending = run.stepCallId ? this.store.call(run.stepCallId) : undefined;
      if (run.waitId) {
        const wait = this.store.wait(run.waitId);
        if (wait.status === 'registered') {
          this.store.putWait({ ...wait, status: 'settled', reason: 'recovery' });
          this.store.event(runId, 'wait.settled', { waitId: wait.id, reason: 'recovery' });
          this.store.putMessage({ id: `recovery-wait:${wait.id}`, sessionId: run.sessionId, from: 'runtime', to: runId, kind: 'event', content: JSON.stringify({ waitId: wait.id, reason: 'recovery', questionIds: wait.questionIds, runIds: wait.runIds, note: 'Interrupted wait has ended. Review current evidence and register another wait if these conditions still matter.' }) });
        }
      }
      for (const auxiliary of this.store.calls(runId).filter(call => call.purpose === 'compaction' && call.status === 'running')) {
        this.store.putCall({ ...auxiliary, status: 'failed', resultRef: this.store.blob({ error: 'SUMMARY_INTERRUPTED: outcome unknown; reservation retained' }) });
        this.store.putSession({ ...this.store.session(run.sessionId), usageEstimated: true });
        this.store.event(runId, 'context.summary.failed', { callId: auxiliary.id, reason: 'interrupted before installation; generation will not be repeated for the same source version' });
      }
      if (pending?.status === 'running') {
        this.store.putCall({ ...pending, status: 'failed', resultRef: this.store.blob({ error: 'MODEL_INTERRUPTED: previous attempt outcome unknown; reservation retained' }) });
        this.store.putSession({ ...this.store.session(run.sessionId), usageEstimated: true });
      }
      this.store.updateRun(runId, { status: 'queued', error: undefined, interruptRequested: false });
      this.store.event(runId, 'run.queued', { reason: 'explicit recovery; recorded tool results are not replayed' });
    });
  }
  classifyRecovery(runId: string): void {
    this.store.transaction(() => {
      for (const call of this.store.calls(runId)) if (call.status === 'running' && call.kind === 'tool') {
        // Internal effects and their result commit atomically. A running record has no committed effect.
        const unknown = call.effect === 'write' && call.effectState !== 'not_started' && !collaborationTool(call.name) && !call.effectAtomic;
        this.store.putCall({ ...call, status: unknown ? 'unknown' : 'planned', ...(unknown ? { effectOutcome: 'unknown', resultRef: call.resultRef ?? this.store.blob({ error: 'UNKNOWN_WRITE: interrupted write may have changed its scope; it will not be replayed automatically', roots: call.effectRoots }) } : {}) });
      }
    });
  }
  private async advance(runId: string, controller: AbortController): Promise<Run> {
    const run = this.store.run(runId);
    const started = Date.now();
    let stopClock = (): void => {};
    try {
      stopClock = this.startClock(run.sessionId);
      if (!run.parentId && !this.store.hasEvent(runId, { types: ['session.started'] })) {
        const startedHook = await this.hooks.run('session.start', { runId, data: { sessionId: run.sessionId } }, controller.signal);
        if (startedHook.notes.length) this.store.updateRun(runId, { contextRef: this.store.blob([...this.store.readBlob<Message[]>(this.store.run(runId).contextRef), attachment('notice', startedHook.notes.join('\n'))]) });
        this.store.event(runId, 'session.started');
      }
      while (!terminal(this.store.run(runId).status) && this.store.run(runId).status !== 'interrupted') {
        controller.signal.throwIfAborted();
        this.store.transaction(() => {
          this.store.updateRun(runId, { status: 'running' });
          this.store.event(runId, 'run.started', {});
        });
        const outcome = await this.executeStep(runId, controller.signal);
        this.store.transaction(() => {
          const current = this.store.run(runId);
          if (terminal(current.status) || current.status === 'interrupted' || current.cancelRequested || current.interruptRequested) return;
          const children = outcome.kind === 'complete' ? childCompletionState(this.store, current) : undefined;
          this.checkpointClock(run.sessionId);
          this.store.updateRun(runId, { activeMs: (run.activeMs ?? 0) + Date.now() - started });
          if (outcome.kind === 'continue') {
            this.store.updateRun(runId, { status: 'queued' });
            this.store.event(runId, 'run.queued');
          } else if (outcome.kind === 'wait') {
            this.mailbox.refresh(runId);
            const wait = this.store.wait(outcome.waitId);
            this.store.updateRun(runId, { status: wait.status === 'registered' ? 'waiting' : 'queued' });
            this.store.event(runId, wait.status === 'registered' ? 'run.waiting' : 'run.queued', { waitId: wait.id });
          } else if (outcome.kind === 'complete' && this.store.inbox(runId).length) {
            const final = this.store.call(current.stepCallId!);
            const response = this.store.readBlob<ModelResponse>(final.resultRef!);
            const context = this.store.readBlob<Message[]>(current.contextRef);
            this.store.updateRun(runId, { status: 'queued', stepCallId: undefined, step: current.step + 1, contextRef: this.store.blob([...context, response.message]) });
            this.store.event(runId, 'run.completion_deferred', { reason: 'new input arrived before terminal commit' });
          } else if (outcome.kind === 'complete' && outcome.workspaceStamp !== undefined && outcome.workspaceStamp !== workspaceWrites(this, run).stamp) {
            // A peer write between validation and the terminal transaction invalidates the verdict.
            // Keep the candidate response and re-run acceptance against the latest directory.
            this.store.updateRun(runId, { status: 'queued' });
            this.store.event(runId, 'completion.invalidated', { reason: 'workspace write changed after public acceptance' });
          } else if (outcome.kind === 'complete' && children && (children.active.length || children.feedback || JSON.stringify(children.result) !== JSON.stringify(this.store.readBlob<{ children?: unknown }>(outcome.resultRef).children))) {
            // Host dispatch or a child outcome may race an asynchronous validator
            // or stop hook. Recheck before committing the parent's terminal state.
            this.store.updateRun(runId, { status: 'queued' });
            this.store.event(runId, 'completion.invalidated', { reason: 'managed child state changed before completion' });
          } else if (outcome.kind === 'complete') {
            const unresolved = unresolvedCompletionWrites(this, current);
            if (unresolved.length) throw new KodoError('UNKNOWN_WRITE', `reconcile unsettled effects before completing this task: ${unresolved.map(call => call.id).join(', ')}`);
            const resultRef = outcome.resultRef;
            this.store.updateRun(runId, { status: 'completed', resultRef });
            this.store.event(runId, 'run.completed', { resultRef });
            this.mailbox.onTerminal(runId);
          } else if (outcome.kind === 'fail') {
            const unresolved = unresolvedCompletionWrites(this, current);
            const failure = unresolved.length && !outcome.error.startsWith('UNKNOWN_WRITE:') ? `UNKNOWN_WRITE: unsettled effects require reconciliation; ${outcome.error}` : outcome.error;
            this.store.updateRun(runId, { status: 'failed', error: failure });
            this.store.event(runId, 'run.failed', { error: failure });
            this.mailbox.onTerminal(runId);
          } else this.cancel(runId, { initiator: 'runtime' });
          const updated = this.store.run(runId);
          if (terminal(updated.status) && !updated.parentId && !updated.error?.startsWith('UNKNOWN_WRITE:')) for (const child of this.store.listRuns(run.sessionId)) if (child.parentId === runId && !terminal(child.status)) this.cancel(child.id, { initiator: 'parent', by: runId });
        });
        if (this.store.run(runId).status === 'waiting') break;
      }
    } catch (error) {
      if (this.store.fault !== undefined) this.stopForStorageFault(error);
      else {
        const current = this.store.run(runId);
        if (!terminal(current.status) && current.status !== 'interrupted' && !current.cancelRequested && !current.interruptRequested) {
          const uncertain = this.store.calls(runId).some(call => call.kind === 'tool' && call.effect === 'write' && (call.status === 'unknown' || call.status === 'running' && call.effectState !== 'not_started' && !call.effectAtomic));
          if (uncertain) this.classifyRecovery(runId);
          const status = !uncertain && error instanceof KodoError && error.code === 'RECOVERY_REQUIRED' ? 'interrupted' : 'failed';
          const failure = uncertain ? `UNKNOWN_WRITE: unsettled effects require reconciliation; ${errorText(error)}` : errorText(error);
          this.store.transaction(() => {
            this.store.updateRun(runId, { status, error: failure, activeMs: (run.activeMs ?? 0) + Date.now() - started });
            this.store.event(runId, `run.${status}`, { error: failure });
            this.mailbox.onTerminal(runId);
            if (status === 'failed' && !run.parentId) for (const child of this.store.listRuns(run.sessionId)) if (child.parentId === runId && !terminal(child.status)) this.cancel(child.id, { initiator: 'parent', by: runId });
          });
        }
      }
    } finally { stopClock(); }
    if (this.storageFailure !== undefined) return { ...run, status: 'interrupted', error: `STORAGE_FAULT: ${errorText(this.storageFailure)}` };
    const ended = this.store.run(runId);
    // Explicit stop convergence owns cleanup and the final notification.
    if (!ended.cancelRequested && !ended.interruptRequested && (terminal(ended.status) || ended.status === 'interrupted')) await this.tools.stopBackground(runId, `run ${ended.status}`);
    return this.store.run(runId);
  }
  onText(runId: string, text: string): void {
    this.textListener(runId, text);
  }
  contextSnapshot(runId: string) {
    const run = this.store.run(runId);
    return inspectContext(this.store, run, toolSpecs(this, run, this.store.session(run.sessionId)), this.compaction, this.assembly);
  }
  /** Host annotations supplement the candidate result; they never replace its text or acceptance evidence. */
  private withHostNotes(resultRef: string | undefined, kind: 'run.stop' | 'subagent.stop' | 'session.end', notes: string[], fallback: Record<string, unknown> = {}): string {
    const result = resultRef ? this.store.readBlob<Record<string, unknown>>(resultRef) : fallback;
    const previous = Array.isArray(result.hostNotes) ? result.hostNotes : [];
    return this.store.blob({ ...result, hostNotes: [...previous, { kind, notes: [...notes] }] });
  }
  private async executeStep(runId: string, signal: AbortSignal): Promise<StepOutcome> {
    const run = this.store.run(runId);
    if (!this.knowledge && run.card.tools.some(name => name === 'knowledge.search' || name === 'knowledge.read')) throw new KodoError('RECOVERY_REQUIRED', 'enable project knowledge before resuming this run');
    assertRunCapabilities(run, this.tools);
    const failed = await runModelStep(this, runId, signal);
    if (failed) return failed;
    const current = this.store.run(runId);
    const modelCall = this.store.call(current.stepCallId!);
    if (modelCall.status !== 'succeeded' || !modelCall.resultRef) throw new KodoError('RECOVERY_REQUIRED', 'model request has no complete persisted response');
    const response = this.store.readBlob<ModelResponse>(modelCall.resultRef);
    if (response.message.tool_calls?.length) return await runToolStep(this, current, modelCall, response, signal);
    // A turn that ends with unsaved deliverables gets a bounded audit before completion checks.
    if (turnEndDelivery(this.store, current, response) === 'continue') return { kind: 'continue' };
    const background = await settleBackground(this, this.store.run(runId), response, signal);
    if (background) return background;
    const outcome = await checkCompletion(this, this.store.run(runId), response, signal);
    if (outcome.kind !== 'complete') return outcome;
    const stopped = await this.hooks.run(current.parentId ? 'subagent.stop' : 'run.stop', { runId, data: { resultRef: outcome.resultRef, response: response.message.content } }, signal);
    if (!stopped.denied) return stopped.notes.length ? { ...outcome, resultRef: this.withHostNotes(outcome.resultRef, current.parentId ? 'subagent.stop' : 'run.stop', stopped.notes) } : outcome;
    this.store.transaction(() => {
      const latest = this.store.run(runId);
      this.store.updateRun(runId, { contextRef: this.store.blob([...this.store.readBlob<Message[]>(latest.contextRef), response.message, attachment('notice', stopped.notes.join('\n'))]), stepCallId: undefined, step: latest.step + 1 });
      this.store.event(runId, 'completion.deferred', { reason: 'host stop hook declined completion' });
    });
    return { kind: 'continue' };
  }
}
