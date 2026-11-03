import { digest, Store } from '../storage/index.js';
import { assertRunCapabilities } from '../tools/bindings.js';
import { nativeRecoveryNames } from '../tools/native-recovery.js';
import { errorText, KodoError } from './types.js';
import type { Call, Run, ToolRecoveryCheck, ToolRecoveryVerifier, ToolRequest } from './types.js';
import { recoveryResolution } from './recovery-resolution.js';
export { recoveryResolution } from './recovery-resolution.js';

export interface PatchRecoveryProbe {
  probePatchForRecovery(runId: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ path: string; hash: string | null; bytes: number }>;
  /** Same-process callbacks can remain alive after the coordinator stops awaiting them. */
  hasInFlightEffects?(runId: string): boolean;
  /** Real hosts pin capability contracts; minimal read-only probe test doubles may omit this. */
  bindingSnapshot?(allowed: string[], skillIds?: readonly string[]): Record<string, string>;
  /** Native file probes serialize their read-only evidence with workspace effects. */
  probeNativeForRecovery?(runId: string, call: Call, request: ToolRequest, signal: AbortSignal): Promise<ToolRecoveryCheck>;
  /** Plan-backed verifier for snapshot integration and host commit calls; undefined for every other call. */
  planVerifier?(call: Call): ToolRecoveryVerifier | undefined;
}
export type RecoveryOutcome = 'succeeded' | 'not_applied' | 'failed';
export interface RecoveryResolution {
  callId: string;
  source: 'probe' | 'verifier' | 'manual';
  outcome: RecoveryOutcome;
  evidence: string;
  originalStatus: Call['status'];
  originalResultRef?: string;
  resultRef?: string;
  retryAuthorized: boolean;
}
export interface RecoveryObservation {
  callId: string;
  evidence: string;
  resolution?: RecoveryResolution;
}
export interface RecoveryPlan {
  sourceRunId: string;
  sessionId: string;
  requiresContinuation: boolean;
  pendingModelCallId?: string;
  /** Effective persisted calls, suitable for copying to a recovery continuation. */
  calls: Call[];
  resolutions: RecoveryResolution[];
  blocked: string[];
  observations: RecoveryObservation[];
}

function latestAttempt(store: Store, runId: string, callId: string): number {
  return store.latestEvent(runId, { types: ['tool.started'], match: { callId } })?.seq ?? 0;
}

/** Reconcile uncertain effects without reopening terminal runs or silently replaying them. */
export class RecoveryManager {
  private verifiers = new Map<string, ToolRecoveryVerifier>();
  constructor(private store: Store, private tools: PatchRecoveryProbe) {}

  assertCanRegisterVerifier(name: string, verifier: ToolRecoveryVerifier): void {
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(name) || typeof verifier !== 'function') throw new KodoError('RECOVERY_VERIFIER', 'provide a valid tool name and verifier function');
    if (name === 'file.apply_patch' || this.verifiers.has(name)) throw new KodoError('RECOVERY_VERIFIER', 'a verifier is already registered for this tool');
  }

  registerVerifier(name: string, verifier: ToolRecoveryVerifier): void {
    this.assertCanRegisterVerifier(name, verifier);
    this.verifiers.set(name, verifier);
  }

  async inspect(runId: string, signal?: AbortSignal): Promise<RecoveryPlan> {
    const run = this.eligible(runId);
    const controller = new AbortController();
    const cancel = (): void => controller.abort(new KodoError('RECOVERY_CANCELLED', 'effect verification was cancelled; uncertain effects remain blocked'));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    // The whole inspection is bounded, including host verifiers that ignore cancellation.
    const timeoutMs = Math.max(1, Math.min(120_000, this.store.session(run.sessionId).budget.toolTimeoutMs));
    const timer = setTimeout(() => controller.abort(new KodoError('RECOVERY_TIMEOUT', 'effect verification timed out; uncertain effects remain blocked')), timeoutMs);
    try { return await this.inspectWithSignal(runId, controller.signal); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }

  private async inspectWithSignal(runId: string, signal: AbortSignal): Promise<RecoveryPlan> {
    signal.throwIfAborted();
    const observations: RecoveryObservation[] = [];
    for (const call of this.store.calls(runId)) {
      signal.throwIfAborted();
      if (!this.uncertain(call) || recoveryResolution(this.store, runId, call.id)) continue;
      const attempt = latestAttempt(this.store, runId, call.id);
      // Legacy whole-file writes carry their before hash in the request. Lean
      // writes omit it and must use the persisted native preparation instead;
      // an omitted hash is not evidence that the original target was absent.
      let legacyPatch = false;
      if (call.name === 'file.apply_patch') {
        try { legacyPatch = Object.hasOwn(JSON.parse(this.request(call).arguments) as object, 'expectedHash'); }
        catch (error) {
          const evidence = `File verification did not establish an outcome: ${errorText(error)}`;
          this.observed(runId, call.id, evidence);
          observations.push({ callId: call.id, evidence });
          continue;
        }
      }
      if (!legacyPatch) {
        const nativeProbe = nativeRecoveryNames.includes(call.name as typeof nativeRecoveryNames[number]) ? this.tools.probeNativeForRecovery?.bind(this.tools) : undefined;
        const verifier = this.verifiers.get(call.name) ?? this.tools.planVerifier?.(call) ?? (nativeProbe ? (({ run, call, request, signal }) => nativeProbe(run.id, call, request, signal)) satisfies ToolRecoveryVerifier : undefined);
        if (!verifier) {
          const evidence = 'No automatic verifier exists for this effect. Explicit user verification is required.';
          this.observed(runId, call.id, evidence);
          observations.push({ callId: call.id, evidence });
          continue;
        }
        let checked: ToolRecoveryCheck;
        try {
          const request = this.request(call);
          const run = this.eligible(runId);
          checked = this.validateCheck(await this.abortable(() => verifier({ run, call: structuredClone(call), request, signal }), signal));
          signal.throwIfAborted();
        } catch (error) {
          const evidence = `Host verification did not establish an outcome: ${errorText(error)}`;
          this.observed(runId, call.id, evidence);
          observations.push({ callId: call.id, evidence });
          if (signal.aborted) signal.throwIfAborted();
          continue;
        }
        if (checked.outcome === 'unknown') {
          this.observed(runId, call.id, checked.evidence);
          observations.push({ callId: call.id, evidence: checked.evidence });
          continue;
        }
        const result = checked.result !== undefined ? checked.result : {
          ...(checked.outcome === 'failed' ? { error: 'RECOVERY_VERIFIED_FAILURE: host verifier established that this operation failed' } : {}),
          recovery: { verifiedByHost: true, outcome: checked.outcome, evidence: checked.evidence },
        };
        const resolution = this.commit(runId, call.id, { source: nativeProbe && !this.verifiers.has(call.name) ? 'probe' : 'verifier', outcome: checked.outcome, evidence: checked.evidence, retryAuthorized: checked.outcome === 'not_applied' }, result, { call, attempt });
        observations.push({ callId: call.id, evidence: checked.evidence, resolution });
        continue;
      }
      let args: Record<string, unknown>;
      let actual: Awaited<ReturnType<PatchRecoveryProbe['probePatchForRecovery']>>;
      try {
        const request = this.request(call);
        args = JSON.parse(request.arguments) as Record<string, unknown>;
        actual = await this.abortable(() => this.tools.probePatchForRecovery(runId, args, signal), signal);
        signal.throwIfAborted();
      } catch (error) {
        const evidence = `File verification did not establish an outcome: ${errorText(error)}`;
        this.observed(runId, call.id, evidence);
        observations.push({ callId: call.id, evidence });
        if (signal.aborted) signal.throwIfAborted();
        continue;
      }
      const after = digest(args.content as string);
      const evidence = `Observed path ${JSON.stringify(actual.path)} with SHA-256 ${actual.hash ?? 'absent'}; expected before ${args.expectedHash ?? 'absent'}, expected after ${after}.`;
      const outcome = actual.hash === after ? 'succeeded' : actual.hash === args.expectedHash ? 'not_applied' : undefined;
      if (!outcome) {
        this.observed(runId, call.id, evidence);
        observations.push({ callId: call.id, evidence });
        continue;
      }
      const result = outcome === 'succeeded' ? { path: actual.path, hash: actual.hash, bytes: actual.bytes, recovery: { verified: true, evidence } } : undefined;
      const resolution = this.commit(runId, call.id, { source: 'probe', outcome, evidence, retryAuthorized: outcome === 'not_applied' }, result, { call, attempt });
      observations.push({ callId: call.id, evidence, resolution });
    }
    return { ...this.plan(runId), observations };
  }

  private request(call: Call): ToolRequest {
    const request = this.store.readBlob<ToolRequest>(call.requestRef);
    if (!request || request.name !== call.name || typeof request.id !== 'string' || typeof request.arguments !== 'string') throw new KodoError('RECOVERY_REQUEST', 'persisted request does not match the uncertain tool call');
    return request;
  }

  private validateCheck(check: ToolRecoveryCheck): ToolRecoveryCheck {
    if (!check || !['succeeded', 'not_applied', 'failed', 'unknown'].includes(check.outcome) || typeof check.evidence !== 'string' || check.evidence.trim().length < 16 || check.evidence.length > 16_000) throw new KodoError('RECOVERY_EVIDENCE', 'host verifier must return a recognized outcome and concrete evidence of 16 to 16000 characters');
    // A definite not_applied verdict is the host's positive verification of absence;
    // an uncertain or failed probe must use unknown, never authorize replay.
    if (check.result !== undefined) {
      try {
        const serialized = JSON.stringify(check.result);
        if (serialized === undefined) throw new Error('result is not JSON');
        return { outcome: check.outcome, evidence: check.evidence.trim(), result: JSON.parse(serialized) as unknown };
      } catch { throw new KodoError('RECOVERY_RESULT', 'host verifier result must be JSON serializable'); }
    }
    return { outcome: check.outcome, evidence: check.evidence.trim() };
  }

  private async abortable<T>(operation: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
    });
    try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), cancelled]); }
    finally { signal.removeEventListener('abort', abort); }
  }

  resolve(runId: string, callId: string, options: { outcome: RecoveryOutcome; evidence: string; retry?: boolean }): RecoveryPlan {
    // Definite manual findings only settle an existing effect. They never execute
    // a retired capability; retry authorization still requires the pinned contract.
    const requireCapabilities = options.outcome !== 'succeeded' && options.outcome !== 'failed';
    this.eligible(runId, requireCapabilities);
    this.ownedCall(runId, callId);
    if (!['succeeded', 'not_applied', 'failed'].includes(options.outcome)) throw new KodoError('RECOVERY_OUTCOME', 'choose succeeded, not_applied or failed');
    const evidence = options.evidence.trim();
    if (evidence.length < 16 || evidence.length > 16_000) throw new KodoError('RECOVERY_EVIDENCE', 'provide a concrete verification statement of 16 to 16000 characters, including what was checked and what it showed');
    if (options.outcome !== 'not_applied' && options.retry === true) throw new KodoError('RECOVERY_RETRY', 'retry is only valid for an effect verified as not_applied');
    const result = options.outcome === 'not_applied' ? undefined : {
      ...(options.outcome === 'failed' ? { error: 'RECOVERY_VERIFIED_FAILURE: user verified this operation failed; the original tool response is unavailable' } : {}),
      recovery: { verifiedByUser: true, outcome: options.outcome, evidence },
    };
    this.commit(runId, callId, { source: 'manual', outcome: options.outcome, evidence, retryAuthorized: options.outcome === 'not_applied' && options.retry === true }, result);
    return this.recordPlan(this.eligible(runId, requireCapabilities));
  }

  plan(runId: string): RecoveryPlan {
    return this.recordPlan(this.eligible(runId));
  }

  private recordPlan(run: Run): RecoveryPlan {
    const runId = run.id;
    const resolutions = this.store.events(runId, { types: ['recovery.resolved'] }).map(x => x.data as unknown as RecoveryResolution);
    const calls = this.store.calls(runId).map(call => {
      const resolution = recoveryResolution(this.store, runId, call.id);
      return resolution ? this.effective(call, resolution) : call;
    });
    return {
      sourceRunId: run.id, sessionId: run.sessionId, requiresContinuation: run.status === 'failed', pendingModelCallId: run.stepCallId,
      calls, resolutions, blocked: calls.filter(call => this.uncertain(call)).map(call => call.id), observations: [],
    };
  }

  private eligible(runId: string, requireCapabilities = true): Run {
    const run = this.store.run(runId);
    const bindingSnapshot = this.tools.bindingSnapshot?.bind(this.tools);
    if (requireCapabilities && bindingSnapshot) assertRunCapabilities(run, { bindingSnapshot });
    if (this.tools.hasInFlightEffects?.(runId)) throw new KodoError('RECOVERY_ACTIVE', 'wait for the original tool callback to settle before reconciling its possible late effects');
    const hasUncertainEffects = this.store.calls(runId).some(call => this.uncertain(call));
    if (run.status !== 'interrupted' && !(run.status === 'failed' && run.error?.startsWith('UNKNOWN_WRITE:')) && !hasUncertainEffects && !this.store.hasEvent(runId, { types: ['recovery.resolved'] })) throw new KodoError('RECOVERY_STATE', 'effect reconciliation requires an interrupted run or a recorded uncertain write; terminal runs are never reopened');
    return run;
  }
  private uncertain(call: Call): boolean { return call.kind === 'tool' && call.effect === 'write' && (call.status === 'unknown' || (call.status === 'running' && call.effectState !== 'not_started' && !call.effectAtomic)); }
  private ownedCall(runId: string, callId: string): Call {
    const call = this.store.call(callId);
    if (call.runId !== runId) throw new KodoError('RECOVERY_OWNER', 'call does not belong to the selected run');
    return call;
  }
  private effective(call: Call, resolution: RecoveryResolution): Call {
    return { ...call, status: resolution.outcome === 'not_applied' ? resolution.retryAuthorized ? 'planned' : 'cancelled' : resolution.outcome, effectOutcome: resolution.outcome === 'not_applied' ? 'not_applied' : 'applied', resultRef: resolution.resultRef };
  }
  private commit(runId: string, callId: string, supplied: Pick<RecoveryResolution, 'source' | 'outcome' | 'evidence' | 'retryAuthorized'>, result: unknown, expected?: { call: Call; attempt: number }): RecoveryResolution {
    return this.store.transaction(() => {
      const manualDefinite = supplied.source === 'manual' && (supplied.outcome === 'succeeded' || supplied.outcome === 'failed') && !supplied.retryAuthorized;
      const run = this.eligible(runId, !manualDefinite);
      const call = this.ownedCall(runId, callId);
      if (expected && (latestAttempt(this.store, runId, callId) !== expected.attempt || call.requestRef !== expected.call.requestRef || call.name !== expected.call.name)) throw new KodoError('RECOVERY_CHANGED', 'tool attempt changed while verification was in progress; inspect the current attempt before reconciling');
      const effectiveResult = result === undefined ? { recovery: { outcome: supplied.outcome, evidence: supplied.evidence }, notApplied: true } : result;
      const existing = recoveryResolution(this.store, runId, callId);
      if (existing) {
        if (existing.source !== supplied.source || existing.outcome !== supplied.outcome || existing.evidence !== supplied.evidence || existing.retryAuthorized !== supplied.retryAuthorized || (existing.resultRef !== undefined && existing.resultRef !== digest(JSON.stringify(effectiveResult)))) throw new KodoError('RECOVERY_CONFLICT', 'this call already has an immutable, different recovery resolution');
        return existing;
      }
      if (!this.uncertain(call)) throw new KodoError('RECOVERY_CALL', 'only an uncertain write can be reconciled');
      const resolution: RecoveryResolution = { callId, ...supplied, originalStatus: call.status, originalResultRef: call.resultRef, ...(supplied.outcome === 'not_applied' && supplied.retryAuthorized ? {} : { resultRef: this.store.blob(effectiveResult) }) };
      // Terminal source records remain unchanged. Their continuation consumes the audited plan.
      if (['interrupted', 'queued', 'waiting', 'running'].includes(run.status)) this.store.putCall(this.effective(call, resolution));
      this.store.event(runId, 'recovery.resolved', { ...resolution });
      return resolution;
    });
  }
  private observed(runId: string, callId: string, evidence: string): void {
    this.store.transaction(() => {
      this.eligible(runId);
      this.ownedCall(runId, callId);
      const previous = this.store.latestEvent(runId, { types: ['recovery.inspected'], match: { callId } });
      if (previous?.data.evidence !== evidence) this.store.event(runId, 'recovery.inspected', { callId, evidence });
    });
  }
}
