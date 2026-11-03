import type { Store } from '../storage/index.js';
import { resolveAgentReference } from '../agents/derive.js';
import { KodoError, terminal } from '../runtime/types.js';
import type { Card, Permission, Run } from '../runtime/types.js';
import { agentIdentity, managedChild } from './agent-lifecycle.js';
import { taskWorkspaceMode } from '../runtime/task-workspace.js';
import type { TaskCheck, TaskContinuation } from '../runtime/task-graph.js';
import { readTaskGraph, requireTaskNode } from '../runtime/task-graph.js';
import { runOutputDirectory } from '../runtime/run-output.js';

/** Trusted scheduler input. None of these execution identities are model-facing tool arguments. */
export interface TaskSpawnRequest {
  runId: string; nodeId: string; generation: number; role: string; goal: string;
  start?: string[]; scope?: string[]; check?: string | TaskCheck; acceptance?: string;
  execution?: Run['execution'];
  continuation?: TaskContinuation;
}

export interface TaskSpawnOverrides {
  runId: string; card: Card; execution?: Run['execution'];
  taskNode: NonNullable<Run['taskNode']>; freshContext: boolean;
  reviseWriteScope?: boolean;
}

/** Lean's fixed tools cannot fulfill named required inputs or a structured report contract. */
export function leanTaskCardIssue(card: Card): string | undefined {
  const required = card.inputs?.filter(input => input.required).map(input => input.name) ?? [];
  if (required.length) return `card ${card.id}@${card.version} requires named inputs (${required.join(', ')}); lean delegate supplies goal, start and check only`;
  // Even a report with no required fields needs report.submit under reportCompleteness.
  if (card.report?.length) return `card ${card.id}@${card.version} requires report.submit; lean children return final text and host-collected evidence instead`;
  return undefined;
}

/** Validate host task identity and turn a graph declaration into the existing spawn admission inputs. */
export function prepareTaskSpawn(store: Store, parent: Run, request: TaskSpawnRequest): { args: Record<string, unknown>; overrides: TaskSpawnOverrides } {
  const session = store.session(parent.sessionId);
  if (session.toolProfile !== 'lean-team' || parent.parentId) throw new KodoError('ROLE_DENIED', 'graph child creation requires a lean-team main run');
  if (!request.runId || !request.nodeId || !Number.isInteger(request.generation) || request.generation < 1) throw new KodoError('TASK_DISPATCH_ID', 'the scheduler must supply a run ID, node ID and positive generation');
  const previous = request.continuation ? store.run(request.continuation.fromRunId) : undefined;
  const reviseWriteScope = request.continuation?.mode === 'resume' && request.continuation.reviseWriteScope === true;
  if (reviseWriteScope) {
    const node = requireTaskNode(readTaskGraph(store, parent.id), request.nodeId);
    if (!previous || node.generation !== request.generation || node.continuation?.fromRunId !== previous.id || !node.continuation.reviseWriteScope || JSON.stringify(node.scope) !== JSON.stringify(request.scope)) throw new KodoError('TASK_SCOPE_REVISION', 'write scope revision must come from the current validated task resume');
  }
  if (previous) {
    if (!managedChild(store, parent, previous) || (!terminal(previous.status) && previous.status !== 'interrupted') || previous.taskNode?.nodeId !== request.nodeId) throw new KodoError('CONTINUATION', 'task continuation requires its own settled child run');
    const identity = agentIdentity(store, previous);
    if (store.listRuns(parent.sessionId).some(run => run.id !== previous.id && run.agentId === identity && ((!terminal(run.status) && !(run.taskNode && run.status === 'interrupted')) || run.continuationOf === previous.id))) throw new KodoError('CONTINUATION', 'continue the latest settled run of this task');
    if (store.unresolvedWrites(undefined, parent.sessionId).some(call => call.runId === previous.id)) throw new KodoError('UNKNOWN_WRITE', 'settle the previous task effects before creating a continuation');
    if (request.continuation!.mode === 'resume') {
      const before = previous.execution, after = request.execution;
      const sameCheckout = before === undefined ? after === undefined : after !== undefined && ['root', 'sourceRoot', 'snapshotRef', 'kind'].every(key => before[key as keyof typeof before] === after[key as keyof typeof after]);
      const integrated = store.latestEvent(parent.id, { types: ['execution.integrated'], match: { childId: previous.id } });
      const sameBase = before?.baseCommit === after?.baseCommit || (typeof integrated?.data.commit === 'string' && after?.baseCommit === integrated.data.commit);
      if (!sameCheckout || !sameBase) throw new KodoError('EXECUTION_REUSE', 'resume must retain the original checkout and an original or recorded integrated base');
    }
  }
  const role = request.role || 'implementer';
  const reference = ['explorer', 'implementer', 'tester', 'reviewer'].includes(role) ? `kodo/${role}@1.4.0` : role;
  const card = previous?.card ?? resolveAgentReference(store, parent, reference);
  const incompatible = leanTaskCardIssue(card);
  if (incompatible) throw new KodoError('TASK_CARD_INCOMPATIBLE', incompatible);
  const shared = role === 'explorer' || taskWorkspaceMode(store, parent.id) === 'shared';
  if (shared && request.execution) throw new KodoError('EXECUTION_PROFILE', 'shared-workspace tasks run without a checkout');
  if (!shared && !request.execution?.snapshotRef) throw new KodoError('EXECUTION_PROFILE', 'task workers require a prepared snapshot checkout');
  if (shared && role !== 'explorer' && role !== 'reviewer' && !request.scope?.length && !previous?.scope?.write?.length) throw new KodoError('SCOPE_REQUIRED', 'shared-workspace tasks require a write scope');
  // A shared-mode reviewer has no disposable checkout, so it cannot run commands in the user's workspace.
  const allowed: Permission[] = role === 'explorer' || (shared && role === 'reviewer') ? ['read'] : role === 'reviewer' ? ['read', 'exec'] : ['read', 'write', 'exec'];
  const permissions = (previous?.permissions ?? parent.permissions ?? session.permissions).filter(permission => allowed.includes(permission));
  const scope = reviseWriteScope ? { ...previous?.scope, write: request.scope } : previous?.scope ?? { ...(request.scope ? { write: request.scope } : {}), ...(role === 'explorer' || role === 'reviewer' ? { write: [] } : {}) };
  const priorResult = previous?.resultRef && request.continuation?.mode === 'redo' ? store.readBlob<{ text?: string }>(previous.resultRef).text?.slice(0, 2000) : undefined;
  const context = {
    workspace: request.execution?.root ?? session.workspace,
    outputDirectory: runOutputDirectory(store, request.runId),
    outputNote: 'Use KODO_RUN_OUTPUT_DIR in commands for logs or intermediate outputs that must survive separate commands; COVERAGE_FILE defaults there. The sandbox may map its path for a command. This is temporary runtime storage; keep durable deliverables in authorized workspace files or artifacts.',
    workspaceNote: shared ? 'Shared workspace; stay inside your scope.' : 'This checkout is authoritative. Use relative paths here; do not change directory to a parent workspace named in handoff text.',
    ...(request.start ? { entryPoints: request.start, entryNote: 'Start here; verify the current code where needed. Supplied interface plans are not proof that dependencies are implemented. Expand exploration for a specific gap or contradiction.' } : {}), ...(request.acceptance ? { acceptance: request.acceptance } : {}),
    ...(request.check ? { check: request.check, checkNote: typeof request.check === 'string' ? 'Descriptive legacy check; not executed by the host.' : 'The host executes this targeted check before delivery. During development select tests for your changes explicitly; coverage options select measured code, not which tests run. Project-wide tests and coverage remain required, but the main runs them after integration. Broaden local checks for a concrete dependency or failure, not solely to repeat final verification.' } : {}),
    ...(request.continuation?.input ? { input: request.continuation.input } : {}), ...(priorResult ? { priorSummary: priorResult } : {}),
  };
  return {
    args: { objective: request.goal, context: JSON.stringify(context), permissions, scope, execution: shared ? 'shared' : 'isolated', ...(previous ? { continuation_of: previous.id } : {}) },
    overrides: { runId: request.runId, card, ...(request.execution ? { execution: request.execution } : {}), taskNode: { ownerId: parent.id, nodeId: request.nodeId, generation: request.generation, role }, freshContext: request.continuation?.mode === 'redo', reviseWriteScope },
  };
}
