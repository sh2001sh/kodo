import type { ProcessFacts } from '../tools/background.js';
import { checkVersion } from './check-hint.js';
import { failHostCall, finishHostCall, openHostCall, startHostCall } from './execution-host-calls.js';
import { runWorkspace } from './execution-workspace.js';
import { moveTaskNode, readTaskGraph, requireTaskNode, writeTaskNode } from './task-graph.js';
import type { TaskCheck, TaskNode, TaskVerification } from './task-graph.js';
import type { TaskRuntimeHost } from './task-execution-host.js';
import { errorText, KodoError, terminal } from './types.js';
import type { Run } from './types.js';

/** Literal argv, not an interpolated shell script: no appended pipeline can hide this program's exit code. */
export function taskCheckCommand(check: TaskCheck): string {
  return `exec ${[check.program, ...check.args].map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' ')}`;
}

/** Checks run independently of tick, so a slow process or lock wait does not stall model scheduling. */
export class TaskChecks {
  private active = new Map<string, { ownerId: string; controller: AbortController; promise: Promise<void> }>();
  private errors = new Map<string, unknown>();
  constructor(private host: TaskRuntimeHost) {}

  get running(): boolean { return this.active.size > 0; }
  busy(ownerId: string): boolean { return [...this.active.values()].some(check => check.ownerId === ownerId); }
  assertHealthy(ownerId: string): void { if (this.errors.has(ownerId)) throw this.errors.get(ownerId); }
  stop(ownerId: string): void {
    for (const check of this.active.values()) if (check.ownerId === ownerId) check.controller.abort(new KodoError('TASK_OWNER_ENDED', 'the task owner stopped'));
  }
  async settle(ownerId: string): Promise<void> {
    this.stop(ownerId);
    await Promise.all([...this.active.values()].filter(check => check.ownerId === ownerId).map(check => check.promise));
    this.assertHealthy(ownerId);
  }
  async shutdown(): Promise<void> {
    const owners = new Set([...this.active.values()].map(check => check.ownerId));
    await Promise.all([...owners].map(ownerId => this.settle(ownerId)));
  }

  /** False until an explicit check passed; missing/legacy checks are visibly unverified for compatibility. */
  ready(main: Run, node: TaskNode): boolean {
    this.assertHealthy(main.id);
    if (!node.check || typeof node.check === 'string') return true;
    if (node.verification?.status === 'passed') return true;
    if (node.verification?.status === 'failed') { this.block(main, node, node.verification); return false; }
    if (!node.runId) throw new KodoError('TASK_CHECK_RUN', 'a host check requires a child run');
    const { store, tools } = this.host;
    if (node.verification?.status === 'running') {
      const id = node.verification.callId!;
      if (this.active.has(id)) return false;
      // A persisted started check without a live owner is not replayable evidence of success.
      const call = store.call(id);
      if (call.status === 'running' || call.status === 'planned') failHostCall(store, id, new KodoError('TASK_CHECK_INTERRUPTED', 'host check interrupted; its outcome was not recorded'));
      this.block(main, node, { ...node.verification, status: 'failed', reason: 'Host check interrupted. Resolve uncertain effects, then use task recheck to retry verification, or resume if child work is needed.' });
      return false;
    }
    const args = { command: taskCheckCommand(node.check), background: false, ...(node.check.timeoutMs ? { timeoutMs: node.check.timeoutMs } : {}) };
    const call = openHostCall(store, main, 'host.task.check', { childId: node.runId, nodeId: node.id, generation: node.generation, check: node.check }, tools.effectRoots(node.runId, 'shell.exec', args), call => {
      writeTaskNode(store, main.id, { ...node, verification: { status: 'running', callId: call.id } }, { action: 'check_queued' });
    });
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => this.execute(main, node, call.id, args, controller.signal))
      .finally(() => { this.active.delete(call.id); if (!store.fault) store.event(main.id, 'task.check.settled', { callId: call.id, nodeId: node.id }); })
      .catch(error => { this.errors.set(main.id, error); });
    this.active.set(call.id, { ownerId: main.id, controller, promise });
    return false;
  }

  /** Called with the child write lock held immediately before committing or settling a read-only/shared result. */
  current(main: Run, node: TaskNode): boolean {
    if (!node.check || typeof node.check === 'string') return true;
    const { store } = this.host;
    const version = checkVersion(store, runWorkspace(store, store.run(node.runId!)));
    if (node.verification?.status === 'passed' && version !== null && version === node.verification.version) return true;
    this.block(main, node, { ...node.verification, status: 'failed', reason: 'The workspace changed after the host check started, or its version is unavailable. Use task recheck to verify current code before delivery; resume if child work is needed.' });
    return false;
  }

  private block(main: Run, node: TaskNode, verification: TaskVerification): void {
    const { store } = this.host;
    const current = requireTaskNode(readTaskGraph(store, main.id), node.id);
    if (current.runId !== node.runId || current.generation !== node.generation) return;
    const patch = { verification, reason: verification.reason };
    if (current.state === 'integrating') moveTaskNode(store, main.id, current, 'needs_input', patch, { action: 'check_failed' });
    else if (current.state === 'stale') writeTaskNode(store, main.id, { ...current, ...patch }, { action: 'check_failed' });
  }

  private async execute(main: Run, node: TaskNode, callId: string, args: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    const { store, tools } = this.host;
    let version: string | undefined, startedAt: number | undefined;
    try {
      const output = await tools.execute(node.runId!, 'shell.exec', args, signal, () => {
        startHostCall(store, callId);
        startedAt = Date.now();
        store.event(main.id, 'task.check.started', { callId, nodeId: node.id, runId: node.runId, version, startedAt });
      }, { callId, onExecutionReady: () => {
        const owner = store.run(main.id);
        if (terminal(owner.status) || owner.status === 'interrupted' || owner.cancelRequested || owner.interruptRequested) throw new KodoError('TASK_OWNER_ENDED', 'the task owner stopped');
        const current = requireTaskNode(readTaskGraph(store, main.id), node.id);
        if (current.runId !== node.runId || current.generation !== node.generation || current.state !== 'integrating') throw new KodoError('TASK_CHECK_STALE', 'task changed while its check was queued');
        version = checkVersion(store, runWorkspace(store, store.run(node.runId!))) ?? undefined;
        if (!version) throw new KodoError('TASK_CHECK_VERSION', 'cannot establish the checked code version; use a supported Git workspace');
      } }) as ProcessFacts;
      const stopped = output.cancelled || output.timedOut || output.signal !== null || output.outputLimitExceeded;
      const uncertain = stopped && output.effects?.verified !== true;
      const passed = !stopped && output.exitCode === 0;
      const finishedAt = Date.now();
      const reason = passed ? undefined : `Host check did not pass (exit=${output.exitCode}, signal=${output.signal}, timeout=${Boolean(output.timedOut)}, cancelled=${output.cancelled}, outputLimit=${output.outputLimitExceeded}). Use task recheck for verification only (optionally replace check), resume for child code fixes, or redo when current integrated changes are needed.`;
      const verification: TaskVerification = { status: passed ? 'passed' : 'failed', callId, version, ...(reason ? { reason } : {}) };
      finishHostCall(store, callId, uncertain ? 'unknown' : passed ? 'succeeded' : 'failed', output.effects?.verified ? output.effects.outcome : uncertain ? 'unknown' : 'applied',
        { ...output, version, startedAt, finishedAt, durationMs: startedAt === undefined ? 0 : finishedAt - startedAt }, () => {
          const current = requireTaskNode(readTaskGraph(store, main.id), node.id);
          if (current.runId !== node.runId || current.generation !== node.generation) return;
          if (passed) writeTaskNode(store, main.id, { ...current, verification }, { action: 'check_passed' });
          else this.block(main, node, verification);
        });
    } catch (error) {
      if (store.fault !== undefined) throw error;
      if (error instanceof KodoError && error.code === 'PROCESS_START') finishHostCall(store, callId, 'failed', 'not_applied', { error: errorText(error), notStarted: true });
      else failHostCall(store, callId, error);
      this.block(main, node, { status: 'failed', callId, version, reason: errorText(error) });
    }
  }
}
