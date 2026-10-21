import { digest, Store } from '../storage/index.js';
import { errorText, KodoError } from './types.js';
import type { Call, Run, ToolRequest } from './types.js';

export interface PatchRecoveryProbe {
  probePatchForRecovery(runId: string, args: Record<string, unknown>): Promise<{ path: string; hash: string | null; bytes: number }>;
}
export type RecoveryOutcome = 'succeeded' | 'not_applied' | 'failed';
export interface RecoveryResolution {
  callId: string;
  source: 'probe' | 'manual';
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

/** Reconcile uncertain effects without reopening terminal runs or silently replaying them. */
export class RecoveryManager {
  constructor(private store: Store, private tools: PatchRecoveryProbe) {}

  async inspect(runId: string): Promise<RecoveryPlan> {
    this.eligible(runId);
    const observations: RecoveryObservation[] = [];
    for (const call of this.store.calls(runId)) {
      if (!this.uncertain(call) || this.resolution(runId, call.id)) continue;
      if (call.name !== 'file.apply_patch') {
        observations.push({ callId: call.id, evidence: 'No automatic verifier exists for this effect. Explicit user verification is required.' });
        continue;
      }
      let args: Record<string, unknown>;
      let actual: Awaited<ReturnType<PatchRecoveryProbe['probePatchForRecovery']>>;
      try {
        const request = this.store.readBlob<ToolRequest>(call.requestRef);
        args = JSON.parse(request.arguments) as Record<string, unknown>;
        actual = await this.tools.probePatchForRecovery(runId, args);
      } catch (error) {
        const evidence = `File verification did not establish an outcome: ${errorText(error)}`;
        this.observed(runId, call.id, evidence);
        observations.push({ callId: call.id, evidence });
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
      const resolution = this.commit(runId, call.id, { source: 'probe', outcome, evidence, retryAuthorized: outcome === 'not_applied' }, result);
      observations.push({ callId: call.id, evidence, resolution });
    }
    return { ...this.plan(runId), observations };
  }

  resolve(runId: string, callId: string, options: { outcome: RecoveryOutcome; evidence: string; retry?: boolean }): RecoveryPlan {
    this.eligible(runId);
    this.ownedCall(runId, callId);
    if (!['succeeded', 'not_applied', 'failed'].includes(options.outcome)) throw new KodoError('RECOVERY_OUTCOME', 'choose succeeded, not_applied or failed');
    const evidence = options.evidence.trim();
    if (evidence.length < 16 || evidence.length > 16_000) throw new KodoError('RECOVERY_EVIDENCE', 'provide a concrete verification statement of 16 to 16000 characters, including what was checked and what it showed');
    if (options.outcome === 'not_applied' && options.retry !== true) throw new KodoError('RECOVERY_RETRY', 'not_applied requires retry:true to explicitly authorize a controlled retry');
    if (options.outcome !== 'not_applied' && options.retry === true) throw new KodoError('RECOVERY_RETRY', 'retry is only valid for an effect verified as not_applied');
    const result = options.outcome === 'not_applied' ? undefined : {
      ...(options.outcome === 'failed' ? { error: 'RECOVERY_VERIFIED_FAILURE: user verified this operation failed; the original tool response is unavailable' } : {}),
      recovery: { verifiedByUser: true, outcome: options.outcome, evidence },
    };
    this.commit(runId, callId, { source: 'manual', outcome: options.outcome, evidence, retryAuthorized: options.outcome === 'not_applied' }, result);
    return this.plan(runId);
  }

  plan(runId: string): RecoveryPlan {
    const run = this.eligible(runId);
    const resolutions = this.store.events(runId).filter(x => x.type === 'recovery.resolved').map(x => x.data as unknown as RecoveryResolution);
    const calls = this.store.calls(runId).map(call => {
      const resolution = this.resolution(runId, call.id);
      return resolution ? this.effective(call, resolution) : call;
    });
    return {
      sourceRunId: run.id, sessionId: run.sessionId, requiresContinuation: run.status === 'failed', pendingModelCallId: run.stepCallId,
      calls, resolutions, blocked: calls.filter(call => this.uncertain(call)).map(call => call.id), observations: [],
    };
  }

  private eligible(runId: string): Run {
    const run = this.store.run(runId);
    const cancelledWithUncertainEffects = run.status === 'cancelled' && this.store.calls(runId).some(call => this.uncertain(call));
    if (run.status !== 'interrupted' && !(run.status === 'failed' && run.error?.startsWith('UNKNOWN_WRITE:')) && !cancelledWithUncertainEffects) throw new KodoError('RECOVERY_STATE', 'effect reconciliation requires an interrupted run, a failed UNKNOWN_WRITE run, or uncertain effects on a cancelled run; terminal runs are never reopened');
    if (this.store.session(run.sessionId).activeSince !== undefined || this.store.listRuns().some(peer => peer.sessionId === run.sessionId && peer.status === 'running')) throw new KodoError('RECOVERY_ACTIVE', 'wait for in-flight session execution to stop before reconciling effects');
    return run;
  }
  private uncertain(call: Call): boolean { return call.kind === 'tool' && call.effect === 'write' && (call.status === 'unknown' || (call.status === 'running' && call.effectState !== 'not_started' && !call.effectAtomic)); }
  private ownedCall(runId: string, callId: string): Call {
    const call = this.store.call(callId);
    if (call.runId !== runId) throw new KodoError('RECOVERY_OWNER', 'call does not belong to the selected run');
    return call;
  }
  private resolution(runId: string, callId: string): RecoveryResolution | undefined {
    const events = this.store.events(runId);
    const latestAttempt = events.filter(x => x.type === 'tool.started' && x.data.callId === callId).at(-1)?.seq ?? 0;
    return events.findLast(x => x.seq > latestAttempt && x.type === 'recovery.resolved' && x.data.callId === callId)?.data as unknown as RecoveryResolution | undefined;
  }
  private effective(call: Call, resolution: RecoveryResolution): Call {
    return { ...call, status: resolution.outcome === 'not_applied' ? 'planned' : resolution.outcome, resultRef: resolution.resultRef };
  }
  private commit(runId: string, callId: string, supplied: Pick<RecoveryResolution, 'source' | 'outcome' | 'evidence' | 'retryAuthorized'>, result: unknown): RecoveryResolution {
    return this.store.transaction(() => {
      const run = this.eligible(runId);
      const call = this.ownedCall(runId, callId);
      const existing = this.resolution(runId, callId);
      if (existing) {
        if (existing.source !== supplied.source || existing.outcome !== supplied.outcome || existing.evidence !== supplied.evidence || existing.retryAuthorized !== supplied.retryAuthorized) throw new KodoError('RECOVERY_CONFLICT', 'this call already has an immutable, different recovery resolution');
        return existing;
      }
      if (!this.uncertain(call)) throw new KodoError('RECOVERY_CALL', 'only an uncertain write can be reconciled');
      const resolution: RecoveryResolution = { callId, ...supplied, originalStatus: call.status, originalResultRef: call.resultRef, ...(supplied.outcome === 'not_applied' ? {} : { resultRef: this.store.blob(result) }) };
      // Terminal source records remain unchanged. Their continuation consumes the audited plan.
      if (run.status === 'interrupted') this.store.putCall(this.effective(call, resolution));
      this.store.event(runId, 'recovery.resolved', { ...resolution });
      return resolution;
    });
  }
  private observed(runId: string, callId: string, evidence: string): void {
    this.store.transaction(() => {
      this.eligible(runId);
      this.ownedCall(runId, callId);
      const previous = this.store.events(runId).filter(x => x.type === 'recovery.inspected' && x.data.callId === callId).at(-1);
      if (previous?.data.evidence !== evidence) this.store.event(runId, 'recovery.inspected', { callId, evidence });
    });
  }
}
