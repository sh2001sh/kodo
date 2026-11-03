import type { Store } from '../storage/index.js';
import { KodoError } from '../runtime/types.js';
import type { Run } from '../runtime/types.js';
import { acceptStaleTask, acknowledgeTaskFailure, completeSelfTask, dropTask, recheckTask, redoTask, resumeTask } from '../runtime/task-lifecycle.js';
import type { TaskResumePatch } from '../runtime/task-lifecycle.js';
import type { TaskCheck } from '../runtime/task-graph.js';
import { readTaskGraph, requireTaskNode } from '../runtime/task-graph.js';
import { childCompletionSummary, inspectRun } from '../runtime/inspection.js';
import { reportCompleteness } from '../agents/contracts.js';

const controlActions = new Set(['wait']);

export function taskActionIsControl(action: string): boolean {
  return controlActions.has(action);
}

export function validateTaskRevision(action: string, args: Record<string, unknown>): void {
  if (action !== 'resume' && args.scope !== undefined) throw new KodoError('TASK_ARGUMENTS', 'scope revisions are only supported by task resume');
  if (action !== 'resume' && action !== 'recheck' && args.check !== undefined) throw new KodoError('TASK_ARGUMENTS', 'check revisions require task resume or recheck');
  if (action === 'recheck' && args.input !== undefined) throw new KodoError('TASK_ARGUMENTS', 'recheck runs only the host check; use resume to send input to the child');
}

export function executeTaskAction(store: Store, run: Run, action: string, args: Record<string, unknown>): unknown {
  if (run.parentId) throw new KodoError('ROLE_DENIED', 'task operations belong to the main agent');
  validateTaskRevision(action, args);
  const graph = readTaskGraph(store, run.id);

  switch (action) {
    case 'done': {
      const id = args.node_id as string;
      const node = completeSelfTask(store, run.id, id, args.note as string | undefined);
      return { id, state: node.state, generation: node.generation };
    }
    case 'drop': {
      const id = args.node_id as string;
      const reason = args.reason as string;
      if (!reason?.trim()) throw new KodoError('TASK_REASON_REQUIRED', 'drop requires a written reason');
      const node = dropTask(store, run.id, id, reason);
      return { id, state: node.state, generation: node.generation, reason: node.reason };
    }
    case 'inspect': {
      const id = args.node_id as string;
      const node = requireTaskNode(graph, id);
      const result: Record<string, unknown> = { id: node.id, goal: node.goal, owner: node.owner, state: node.state, generation: node.generation,
        acceptance: node.acceptance, verification: node.verification,
        ...(node.role ? { role: node.role } : {}), ...(node.after.length ? { after: node.after } : {}), ...(node.start ? { start: node.start } : {}),
        ...(node.scope ? { scope: node.scope } : {}), ...(node.check ? { check: node.check } : {}), ...(node.runId ? { runId: node.runId } : {}),
        ...(node.reason ? { reason: node.reason } : {}), ...(node.dependencyChanged ? { dependencyChanged: true } : {}), ...(node.acknowledged ? { acknowledged: true } : {}) };
      if (node.runId && store.run(node.runId).status === 'completed') {
        const child = store.run(node.runId);
        const reportStatus = reportCompleteness(store, child);
        const evidence = childCompletionSummary(store, run, child, reportStatus);
        result.evidence = evidence;
      }
      if (node.runId) result.run = inspectRun(store, run, { ...args, run_id: node.runId });
      if (node.verification?.callId) {
        const check = store.call(node.verification.callId);
        if (check.resultRef) result.hostCheck = store.readBlob(check.resultRef);
      }
      acknowledgeTaskFailure(store, run.id, id);
      return inspectionPointers(result, id, node.runId);
    }
    case 'accept': {
      const id = args.node_id as string;
      const reason = args.reason as string;
      const node = acceptStaleTask(store, run.id, id, reason);
      return { id, state: node.state, generation: node.generation };
    }
    case 'resume': {
      const id = args.node_id as string;
      const node = resumeTask(store, run.id, id, args.input as string | undefined, { scope: args.scope, check: args.check } as TaskResumePatch);
      return { id, state: node.state, generation: node.generation, runId: node.runId };
    }
    case 'recheck': {
      const id = args.node_id as string;
      const node = recheckTask(store, run.id, id, args.check as TaskCheck | undefined);
      return { id, state: node.state, generation: node.generation, runId: node.runId, note: 'Host check queued on the retained checkout; no child model run was started.' };
    }
    case 'redo': {
      const id = args.node_id as string;
      const { node, notices } = redoTask(store, run.id, id, args.input as string | undefined);
      return { id, state: node.state, generation: node.generation, superseded: node.superseded, notices: notices.map(notice => ({ nodeId: notice.nodeId, reason: notice.reason, ...(notice.runId ? { runId: notice.runId } : {}) })) };
    }
    case 'wait': case 'send': case 'release': case 'cancel': case 'interrupt':
      throw new KodoError('TASK_HOST_REQUIRED', `${action} must execute through the task runtime host`);
    default:
      throw new KodoError('TOOL_ARGUMENTS', `unknown task action: ${action}`);
  }
}

/** Inspection pagination stays usable through the advertised task tool. */
function inspectionPointers(value: unknown, nodeId: string, runId: string | undefined): unknown {
  if (Array.isArray(value)) return value.map(item => inspectionPointers(item, nodeId, runId));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (['next', 'nextObservations', 'inspect'].includes(key) && item && typeof item === 'object' && item.run_id === runId) {
      const { run_id: _runId, ...args } = item as Record<string, unknown>;
      void _runId;
      return [key, { tool: 'task', args: { action: 'inspect', node_id: nodeId, ...args } }];
    }
    return [key, inspectionPointers(item, nodeId, runId)];
  }));
}
