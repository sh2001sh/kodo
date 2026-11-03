import { searchRosterCards } from '../agents/discovery.js';
import { executeTaskAction, validateTaskRevision } from '../messaging/task-tool.js';
import { leanTaskCardIssue } from '../messaging/task-spawn.js';
import { declareTasks, builtinTaskRoles } from './task-declare.js';
import type { TaskDeclaration } from './task-declare.js';
import { readTaskGraph, requireTaskNode, writeTaskNode } from './task-graph.js';
import type { TaskNode } from './task-graph.js';
import { cleanRetiredCheckouts, releaseTaskCheckout, scheduleTasks, taskLockBusy } from './task-dispatch.js';
import { acceptStaleTask, finishTaskIntegration, recordTaskRunOutcome, resumeTask, taskIntegrationCurrent } from './task-lifecycle.js';
import { discardTaskCheckout, nodeHasDelivery, taskExecutionHost } from './task-execution-host.js';
import type { TaskRuntimeHost } from './task-execution-host.js';
import { hostCommitChild, cleanupSessionCheckouts } from './execution-lean.js';
import { integrateNodeLocked, recoverHostCalls } from './execution-integration.js';
import { childCompletionSummary } from './inspection.js';
import { writeScopesOverlap } from './scope.js';
import { freezeTaskWorkspace, sharedWorkspaceNote, taskWorkspaceMode } from './task-workspace.js';
import { boundTaskNotice } from './task-notice.js';
import { errorText, KodoError, terminal } from './types.js';
import type { Run } from './types.js';
import type { WorkspaceLocks } from './execution-host-calls.js';
import { TaskChecks } from './task-checks.js';

/** Connects durable graph records to the existing run driver; never performs IO in a tool transaction. */
export class TaskRuntime {
  private passes = new Map<string, Promise<void>>();
  private controllers = new Map<string, AbortController>();
  private cleanupRetried = new Set<string>();
  private retryOwners = new Set<string>();
  private retryAfter = new Map<string, number>();
  private checks: TaskChecks;
  private passFailures = new Map<string, unknown>();
  constructor(private host: TaskRuntimeHost) { this.checks = new TaskChecks(host); }
  stop(ownerId: string): void {
    this.controllers.get(ownerId)?.abort(new KodoError('TASK_OWNER_ENDED', 'the task owner stopped'));
    this.checks.stop(ownerId);
  }
  async settle(ownerId: string): Promise<void> {
    await this.passes.get(ownerId);
    await this.checks.settle(ownerId);
    this.assertPassHealthy(ownerId);
  }
  get busy(): boolean { return this.checks.running || this.passes.size > 0; }
  async shutdown(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort(new KodoError('TASK_OWNER_ENDED', 'the host is shutting down'));
    const outcomes = await Promise.allSettled([...this.passes.values(), this.checks.shutdown()]);
    const failures = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason] : []);
    if (failures.length) throw new AggregateError(failures, 'task shutdown failed');
  }

  private assertPassHealthy(ownerId: string): void {
    if (this.passFailures.has(ownerId)) throw this.passFailures.get(ownerId);
  }

  /** Let the main model work while host-only checkout IO proceeds; callers can still explicitly await tick. */
  async tickForModel(sessionId: string): Promise<void> {
    for (const run of this.host.store.listRuns(sessionId)) {
      if (!terminal(run.status) && run.status !== 'interrupted') this.assertPassHealthy(run.id);
    }
    await Promise.race([this.tick(sessionId, true), new Promise<void>(resolve => setImmediate(resolve))]);
  }

  /** Retry host-only lock contention without waking the model, including locks held by another process. */
  retryDelay(sessionId: string): number | undefined {
    return this.host.store.listRuns(sessionId).some(run => (this.passes.has(run.id) || this.retryOwners.has(run.id) || this.checks.busy(run.id)) && !terminal(run.status) && run.status !== 'interrupted') ? 250 : undefined;
  }

  private locks(ownerId: string): WorkspaceLocks {
    return { workspaceWriteLock: async (runId, signal) => {
      try { return await this.host.tools.workspaceWriteLock(runId, signal, true); }
      catch (error) { if (taskLockBusy(error)) { this.retryOwners.add(ownerId); this.retryAfter.set(ownerId, Date.now() + 250); } throw error; }
    }, checkoutWriteLock: async (runId, root, signal) => {
      try { return await this.host.tools.checkoutWriteLock(runId, root, signal, true); }
      catch (error) { if (taskLockBusy(error)) { this.retryOwners.add(ownerId); this.retryAfter.set(ownerId, Date.now() + 250); } throw error; }
    } };
  }

  wait(run: Run, nodeIds: string[], mode: 'any' | 'all'): { waitId: string } {
    return this.host.mailbox.waitForTasks(run, nodeIds, mode);
  }

  operation(run: Run, callId: string, name: string, args: Record<string, unknown>): unknown {
    const { store, mailbox } = this.host;
    const session = store.session(run.sessionId);
    if (run.parentId || session.toolProfile !== 'lean-team') throw new KodoError('ROLE_DENIED', 'task operations require a lean-team main run');
    if (name === 'find_agents') {
      const result = searchRosterCards(store, session.id, { query: args.query as string, limit: 5 });
      return { ...result, cards: result.cards.map(card => {
        const reason = leanTaskCardIssue(store.card(card.id, card.version));
        return { ...card, compatible: !reason, ...(reason ? { reason } : {}) };
      }) };
    }
    if (name === 'delegate') {
      const roles = [...builtinTaskRoles, ...(store.cards.rosterSnapshot(session.id)?.members.filter(member => member.availability === 'available' && !leanTaskCardIssue(member.card)).map(member => member.card.id) ?? [])];
      // The mode is frozen with the first declaration; a rejected declaration records neither.
      const { graph, mode } = store.transaction(() => {
        const mode = freezeTaskWorkspace(store, run.id, session.workspace);
        return { mode, graph: declareTasks(store, run.id, args as unknown as TaskDeclaration, { roles, maxTaskNodes: session.maxTaskNodes, requireScope: mode === 'shared' }) };
      });
      const warnings = graph.nodes.flatMap((node, index) => node.owner === 'agent' && node.scope?.length ? graph.nodes.slice(index + 1)
        .filter(peer => peer.owner === 'agent' && peer.scope?.length && !peer.after.includes(node.id) && !node.after.includes(peer.id) && writeScopesOverlap({ write: node.scope }, { write: peer.scope }))
        .map(peer => `Tasks ${node.id} and ${peer.id} have overlapping write scopes; their deliveries may conflict.`) : []).slice(0, 5);
      const delivery = mode === 'shared' ? `${sharedWorkspaceNote} Task inspect expands evidence.` : 'Child changes are integrated before dependants start; task inspect expands evidence.';
      return { tasks: graph.nodes, workspaceMode: mode, ...(warnings.length ? { warnings } : {}), note: `Ready children start automatically. Do independent self work before task wait. Give children targeted checks; run the project's required repository-wide checks after all integrations, reusing successful checks while covered code is unchanged. ${delivery} A structured check gates delivery; missing or text-only checks are unverified. Use resume for fixes in the retained checkout; use redo for fixes needing current integrated changes. Resolve behavior conflicts before resuming; drop requires a reason.` };
    }
    const action = args.action as string;
    validateTaskRevision(action, args);
    if (action === 'wait') return this.wait(run, args.node_ids as string[], (args.mode as 'any' | 'all') ?? 'any');
    const node = requireTaskNode(readTaskGraph(store, run.id), args.node_id as string);
    if ((action === 'recheck' || (action === 'resume' && (args.scope !== undefined || args.check !== undefined))) && node.runId
      && (this.host.busy(node.runId) || this.host.tools.hasInFlightEffects(node.runId) || this.host.tools.backgroundRunning(node.runId))) {
      throw new KodoError('EXECUTION_ACTIVE', 'wait for the previous task and its effects to settle before revising or rechecking');
    }
    if (action === 'release') {
      if (['pending', 'queued', 'running', 'integrating'].includes(node.state)) throw new KodoError('TASK_NODE_STATE', 'only settled tasks can release their checkout');
      store.event(run.id, 'task.release.requested', { nodeId: node.id, generation: node.generation, callId });
      return { node_id: node.id, status: 'release_queued' };
    }
    if (action === 'cancel' || action === 'interrupt') {
      if (!node.runId || node.state !== 'running') throw new KodoError('TASK_NODE_STATE', 'cancel and interrupt require a running child task');
      if (action === 'cancel') this.host.cancel(node.runId); else this.host.interrupt(node.runId);
      return { node_id: node.id, status: `${action}_requested` };
    }
    if (action === 'send') {
      const input = args.input as string;
      if (!input?.trim()) throw new KodoError('TASK_ARGUMENTS', 'send requires input text');
      if (node.state === 'needs_input') return resumeTask(store, run.id, node.id, input);
      if (!node.runId || node.state !== 'running') throw new KodoError('TASK_NODE_STATE', 'send requires a running task or one that needs input');
      return mailbox.execute(run, callId, 'send_message', { to: node.runId, kind: 'notice', content: input });
    }
    if (action === 'accept') {
      const accepted = acceptStaleTask(store, run.id, node.id, args.reason as string, Boolean(node.runId && (typeof node.check === 'object' || !nodeHasDelivery(store, run, node))));
      return { id: accepted.id, state: accepted.state, generation: accepted.generation };
    }
    const result = executeTaskAction(store, run, action, args);
    if (action === 'redo') for (const notice of (result as { notices: { nodeId: string; runId?: string; reason: string }[] }).notices) {
      if (!notice.runId || terminal(store.run(notice.runId).status)) continue;
      store.putMessage({ id: `task-change:${callId}:${notice.nodeId}`, sessionId: run.sessionId, from: 'runtime', to: notice.runId, kind: 'event', content: JSON.stringify({ reason: 'dependency_changed', predecessor: node.id, note: 'A prerequisite was restarted. Your current snapshot has not changed; your result will require explicit review or redo before integration.' }) });
    }
    if (action === 'drop' && node.runId && !terminal(store.run(node.runId).status)) this.host.cancel(node.runId);
    return result;
  }

  /** A single pass per owner prevents duplicate dispatch/integration while peers finish concurrently. */
  tick(sessionId: string, deferRetries = false): Promise<void> {
    const { store } = this.host;
    if (store.session(sessionId).toolProfile !== 'lean-team') return Promise.resolve();
    const runs = store.listRuns(sessionId);
    if (runs.every(run => terminal(run.status)) && !store.unresolvedWrites(undefined, sessionId).length) {
      const ended = runs.find(run => !run.parentId && store.hasEvent(run.id, { types: ['session.ended'] }) && store.hasEvent(run.id, { types: ['execution.cleanup_failed'] }));
      if (ended && !this.cleanupRetried.has(sessionId)) {
        this.cleanupRetried.add(sessionId);
        return cleanupSessionCheckouts(store, this.host.tools, ended).then(() => {});
      }
    }
    return Promise.all(runs.filter(run => !run.parentId && !terminal(run.status) && run.status !== 'interrupted' && !run.cancelRequested && !run.interruptRequested
      && (!deferRetries || this.passes.has(run.id) || (this.retryAfter.get(run.id) ?? 0) <= Date.now())).map(run => {
      const existing = this.passes.get(run.id);
      if (existing) return existing;
      const controller = new AbortController();
      this.controllers.set(run.id, controller);
      const pass = this.advance(run, controller.signal).catch(error => { if (!controller.signal.aborted || store.fault !== undefined) { this.passFailures.set(run.id, error); throw error; } })
        .finally(() => { this.passes.delete(run.id); this.controllers.delete(run.id); });
      this.passes.set(run.id, pass);
      return pass;
    })).then(() => {});
  }

  private async advance(main: Run, signal: AbortSignal): Promise<void> {
    const { store } = this.host;
    this.checks.assertHealthy(main.id);
    const locks = this.locks(main.id);
    this.retryOwners.delete(main.id);
    try { await recoverHostCalls(store, locks, main, signal); }
    catch (error) { if (taskLockBusy(error)) return; throw error; }
    for (const node of readTaskGraph(store, main.id).nodes) {
      if (node.state === 'dropped' && node.runId && store.run(node.runId).cancelRequested) await this.host.waitForStop(node.runId);
      if (node.state === 'running' && node.runId && !this.host.busy(node.runId)) {
        const child = store.run(node.runId);
        if (child.status === 'completed' || child.status === 'failed' || child.status === 'cancelled' || child.status === 'interrupted') {
          const text = child.resultRef ? store.readBlob<{ text?: string }>(child.resultRef).text : undefined;
          recordTaskRunOutcome(store, main.id, node.id, child.id, { status: child.status, finalText: text, integrate: taskWorkspaceMode(store, main.id) === 'snapshot' && node.role !== 'explorer' && node.role !== 'reviewer' });
        }
      }
      const current = requireTaskNode(readTaskGraph(store, main.id), node.id);
      if (current.state === 'integrating') await this.integrate(main, current, signal);
      const settled = requireTaskNode(readTaskGraph(store, main.id), node.id);
      if (!['pending', 'queued', 'running', 'integrating'].includes(settled.state)) this.notify(main, settled);
      if (!['pending', 'queued', 'running', 'integrating'].includes(settled.state)) {
        try { await cleanRetiredCheckouts(store, main.id, node.id, checkout => discardTaskCheckout(this.host, main, checkout, locks, signal)); }
        catch (error) { if (!taskLockBusy(error)) store.event(main.id, 'execution.cleanup_failed', { nodeId: node.id, error: errorText(error) }); }
      }
    }
    for (const request of store.events(main.id, { types: ['task.release.requested'] })) {
      if (store.hasEvent(main.id, { types: ['task.release.finished'], match: { requestSeq: request.seq } })) continue;
      try {
        const node = requireTaskNode(readTaskGraph(store, main.id), String(request.data.nodeId));
        if (node.generation !== request.data.generation) throw new KodoError('TASK_GENERATION', 'release request was superseded');
        await releaseTaskCheckout(store, main.id, node.id, checkout => discardTaskCheckout(this.host, main, checkout, locks, signal));
        store.event(main.id, 'task.release.finished', { requestSeq: request.seq, nodeId: node.id });
      } catch (error) {
        if (taskLockBusy(error)) continue;
        store.event(main.id, 'task.release.finished', { requestSeq: request.seq, error: errorText(error) });
        store.putMessage({ id: `release:${request.seq}`, sessionId: main.sessionId, from: 'runtime', to: main.id, kind: 'event', content: `Checkout release failed: ${errorText(error)}` });
      }
    }
    if (store.unresolvedWrites(undefined, main.sessionId).length || terminal(store.run(main.id).status) || store.run(main.id).cancelRequested) return;
    try { await scheduleTasks(store, main.id, { ...taskExecutionHost(this.host, main, signal, locks), isIntegrated: node => nodeHasDelivery(store, main, node) }); }
    catch (error) { if (!taskLockBusy(error)) throw error; }
    this.host.mailbox.refresh(main.id);
  }

  private async integrate(main: Run, node: TaskNode, signal: AbortSignal): Promise<void> {
    const { store } = this.host;
    const locks = this.locks(main.id);
    if (!node.runId || !taskIntegrationCurrent(store, main.id, node.id, node.generation)) return;
    if (store.unresolvedWrites(undefined, main.sessionId).length) return;
    if (!this.checks.ready(main, node)) return;
    // ready may have updated durable verification after the node was read.
    node = requireTaskNode(readTaskGraph(store, main.id), node.id);
    const childId = node.runId!;
    try {
      if (taskWorkspaceMode(store, main.id) === 'shared' || node.role === 'explorer' || node.role === 'reviewer') {
        const release = await locks.workspaceWriteLock(node.runId!, signal);
        try {
          if (this.checks.current(main, node)) finishTaskIntegration(store, main.id, node.id, node.generation, { status: 'no_changes' });
        } finally { release(); }
        return;
      }
      const requireWrite = (): void => {
        const session = store.session(main.sessionId), current = store.run(main.id);
        if (!session.permissions.includes('write') || !(current.permissions ?? session.permissions).includes('write')) throw new KodoError('PERMISSION_DENIED', 'host delivery requires the main run\'s current write permission');
      };
      requireWrite();
      // Reserve the destination before committing the child. A busy main workspace
      // must only queue integration, not repeat a host commit on every retry tick.
      // Both acquisitions are try-only; a busy child releases the main lock below.
      const release = await locks.workspaceWriteLock(main.id, signal);
      try {
        requireWrite();
        if (!taskIntegrationCurrent(store, main.id, node.id, node.generation) || terminal(store.run(main.id).status) || store.run(main.id).cancelRequested) return;
        const childRelease = await locks.workspaceWriteLock(childId, signal);
        let commit;
        try {
          requireWrite();
          const currentMain = store.run(main.id);
          if (terminal(currentMain.status) || currentMain.cancelRequested) return;
          if (!taskIntegrationCurrent(store, main.id, node.id, node.generation) || !this.checks.current(main, node)) return;
          commit = hostCommitChild(store, main, childId);
        } finally { childRelease(); }
        if (commit.status === 'rejected') {
          finishTaskIntegration(store, main.id, node.id, node.generation, { status: 'failed', detail: JSON.stringify(commit.violations) });
          return;
        }
        const already = store.latestEvent(main.id, { types: ['execution.integrated'], match: { childId, commit: commit.commit } });
        const result = already ? { status: 'applied' as const, files: commit.files, version: already.data.version } : integrateNodeLocked(store, main, childId);
        store.transaction(() => {
          if (result.status !== 'conflict') store.event(main.id, 'task.delivery', { nodeId: node.id, generation: node.generation, runId: node.runId, ...result });
          finishTaskIntegration(store, main.id, node.id, node.generation, { status: result.status === 'conflict' ? 'conflict' : result.status === 'empty' ? 'no_changes' : 'integrated', ...(result.status === 'conflict' ? { detail: result.message } : {}) });
        });
      } finally { release(); }
    } catch (error) {
      if (store.fault !== undefined) throw error;
      if (taskLockBusy(error)) {
        const current = requireTaskNode(readTaskGraph(store, main.id), node.id);
        const reason = 'Waiting for the workspace lock to integrate the task result.';
        if (current.state === 'integrating' && current.reason !== reason) writeTaskNode(store, main.id, { ...current, reason }, { action: 'integration_waiting' });
        return;
      }
      finishTaskIntegration(store, main.id, node.id, node.generation, { status: 'failed', detail: errorText(error) });
    }
  }

  private notify(main: Run, node: TaskNode): void {
    const { store } = this.host;
    const revision = store.latestEvent(main.id, { types: ['task.node.updated'], match: { nodeId: node.id } })!;
    const id = `task-result:${main.id}:${revision.seq}`;
    if (store.message(id)) return;
    const child = node.runId ? store.run(node.runId) : undefined;
    const summary = child?.resultRef ? store.readBlob<{ text?: string }>(child.resultRef).text : undefined;
    const evidence = child ? childCompletionSummary(store, main, child) : undefined;
    const checkVersions = child ? store.events(child.id, { types: ['check.started'] }).slice(-6).map(event => ({ callId: event.data.callId, version: event.data.version })) : [];
    const delivery = store.latestEvent(main.id, { types: ['task.delivery'], match: { nodeId: node.id, generation: node.generation } });
    const notice = { task: node.id, state: node.state, generation: node.generation, runId: node.runId, reason: node.reason, verification: node.verification,
      summary, evidence, checkVersions, integration: delivery?.data, note: taskWorkspaceMode(store, main.id) === 'shared' ? 'The child wrote the shared workspace directly; its checks ran before any later writes, so verify the workspace before final delivery.' : 'Child checks cover the child snapshot; verify the integrated workspace before final delivery.', inspect: { tool: 'task', args: { action: 'inspect', node_id: node.id } } };
    const content = boundTaskNotice(notice, full => store.artifact(main.id, store.blob(full)));
    store.putMessage({ id, sessionId: main.sessionId, from: 'runtime', to: main.id, kind: 'event', content });
  }

  async cleanup(main: Run): Promise<void> {
    await this.settle(main.id);
    if (this.host.store.session(main.sessionId).toolProfile !== 'lean-team') return;
    if (!this.host.store.hasEvent(main.id, { types: ['execution.snapshot', 'execution.snapshot.captured'] }) || this.host.store.unresolvedWrites(undefined, main.sessionId).length) return;
    await cleanupSessionCheckouts(this.host.store, this.host.tools, main);
  }
}
