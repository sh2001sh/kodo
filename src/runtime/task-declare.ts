import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Store } from '../storage/index.js';
import { KodoError } from './types.js';
import type { FileScope } from './types.js';
import { canAccessFileScope, normalizeFileScope } from './scope.js';
import { readTaskGraph, removeTaskNode, writeTaskNode } from './task-graph.js';
import type { TaskGraph, TaskNode, TaskNodeSpec } from './task-graph.js';

/** One `delegate` call: new or changed declarations, plus IDs of unstarted nodes to delete. */
export interface TaskDeclaration { tasks: TaskNodeSpec[]; remove?: string[] }
export interface TaskDeclareOptions {
  /** Valid child roles; built-in roles by default. */
  roles?: readonly string[];
  /** Session graph-size budget (plan 5.3), independent of the active-run quota. */
  maxTaskNodes?: number;
  /** Shared-workspace mode (6.7): every task that may write must name its scope. */
  requireScope?: boolean;
  /** Current workspace (retained checkout when resuming) for early path diagnostics. */
  workspace?: string;
  parentScope?: FileScope;
}
export const builtinTaskRoles: readonly string[] = ['explorer', 'implementer', 'tester', 'reviewer'];
export const defaultMaxTaskNodes = 32;
const nodeId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** A node may be changed or deleted only before any run or dispatch preparation served it. */
export const taskNodeUnstarted = (node: TaskNode): boolean => (node.state === 'pending' || node.state === 'queued') && node.generation === 1 && !node.runId && !node.superseded?.length;

export function taskSpecErrors(spec: TaskNodeSpec, options: TaskDeclareOptions = {}): string[] {
  const roles = options.roles ?? builtinTaskRoles, requireScope = options.requireScope ?? false;
  const errors: string[] = [];
  const label = `task ${JSON.stringify(spec.id)}`;
  if (typeof spec.id !== 'string' || !nodeId.test(spec.id)) errors.push(`${label}: id must be 1-64 letters, digits, ".", "_" or "-"`);
  if (typeof spec.goal !== 'string' || !spec.goal.trim()) errors.push(`${label}: goal is required`);
  if (spec.owner !== undefined && spec.owner !== 'self') errors.push(`${label}: owner may only be "self"`);
  if (spec.owner === 'self' && spec.role !== undefined) errors.push(`${label}: a self task has no role`);
  if (spec.owner !== 'self' && spec.role !== undefined && !roles.includes(spec.role)) errors.push(`${label}: role must be one of ${roles.join(', ')}`);
  for (const field of ['after', 'start', 'scope'] as const) {
    const value = spec[field];
    if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item))) errors.push(`${label}: ${field} must be a list of non-empty strings`);
  }
  if (spec.after && new Set(spec.after).size !== spec.after.length) errors.push(`${label}: after lists a task twice`);
  if (spec.after?.includes(spec.id)) errors.push(`${label}: a task cannot depend on itself`);
  if (spec.acceptance !== undefined && (typeof spec.acceptance !== 'string' || !spec.acceptance.trim())) errors.push(`${label}: acceptance must be non-empty text`);
  if (spec.check !== undefined) {
    const check = spec.check;
    if (typeof check === 'string') {
      if (!check.trim()) errors.push(`${label}: legacy check text must not be empty`);
    } else if (!check || typeof check.program !== 'string' || !check.program.trim() || check.program.includes('\0') ||
      !Array.isArray(check.args) || check.args.some(arg => typeof arg !== 'string' || arg.includes('\0')) ||
      (check.timeoutMs !== undefined && (!Number.isInteger(check.timeoutMs) || check.timeoutMs < 1 || check.timeoutMs > 86_400_000))) {
      errors.push(`${label}: check requires program, args and an optional positive timeoutMs (up to 86400000)`);
    } else if (spec.owner === 'self' || spec.role === 'explorer' || (requireScope && spec.role === 'reviewer')) {
      errors.push(`${label}: host checks require an executable child role`);
    } else if (requireScope) {
      errors.push(`${label}: structured host checks currently require a Git snapshot workspace; shared tasks may supply descriptive acceptance instead`);
    }
  }
  if (requireScope && spec.owner !== 'self' && spec.role !== 'explorer' && spec.role !== 'reviewer' && !spec.scope?.length) errors.push(`${label}: scope is required because child tasks share the workspace`);
  if (!errors.length) errors.push(...scopeErrors(spec, options));
  return errors;
}

/** Diagnostics only: existing read-only tests need not be writable by this child. */
function scopeErrors(spec: TaskNodeSpec, options: TaskDeclareOptions): string[] {
  const label = `task ${JSON.stringify(spec.id)}`, errors: string[] = [];
  let scope: FileScope;
  try { scope = normalizeFileScope(spec.scope === undefined ? {} : { write: spec.scope }, options.parentScope); }
  catch (error) { if (error instanceof KodoError) return [`${label}: ${error.message}`]; throw error; }
  const workspace = options.workspace;
  if (!workspace) return errors;
  for (const entry of spec.scope ?? []) {
    if (/\s/u.test(entry) && !existsSync(path.resolve(workspace, entry))) {
      errors.push(`${label}: scope ${JSON.stringify(entry)} does not exist and contains whitespace. scope must contain only literal paths; put explanations in goal or acceptance, e.g. scope:["tests/x.py"], acceptance:"Create the test file". For a genuinely new filename with spaces, create it first or declare its intended directory. Existing filenames are never rewritten.`);
    }
  }
  if (!spec.check || typeof spec.check === 'string') return errors;
  // Inline code, module names, selectors and option values are not positional file targets.
  const valueOptions = new Set(['-c', '-e', '--eval', '-k', '-m', '-p', '-o', '--override-ini', '--ignore', '--ignore-glob', '--cov', '--cov-report', '--cov-config', '--junitxml', '--junit-xml', '--rootdir', '--confcutdir', '--basetemp', '--output', '-O']);
  let skip = false, positional = false;
  for (const arg of spec.check.args) {
    if (skip) { skip = false; continue; }
    if (!positional && arg === '--') { positional = true; continue; }
    if (!positional && arg.startsWith('-')) { skip = valueOptions.has(arg); continue; }
    const target = arg.split('::')[0]!;
    if ((!target.includes('/') && !/\.(py|ts)$/u.test(target)) || path.isAbsolute(target) || path.win32.isAbsolute(target) || /^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
    const resolved = path.resolve(workspace, target);
    if (existsSync(resolved)) continue;
    if (!canAccessFileScope(scope, 'write', workspace, resolved)) errors.push(`${label}: missing check path ${JSON.stringify(target)} is outside scope. Declare its literal path, e.g. scope:[${JSON.stringify(target)}], or correct check.args; put path explanations in goal or acceptance.`);
  }
  return errors;
}

/** The first dependency cycle as a node path, or undefined for a DAG. */
export function findTaskCycle(nodes: readonly Pick<TaskNode, 'id' | 'after'>[]): string[] | undefined {
  const edges = new Map(nodes.map(node => [node.id, node.after]));
  const state = new Map<string, 'open' | 'closed'>();
  const path: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'closed') return undefined;
    if (state.get(id) === 'open') return [...path.slice(path.indexOf(id)), id];
    state.set(id, 'open');
    path.push(id);
    for (const next of edges.get(id) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, 'closed');
    return undefined;
  };
  for (const node of nodes) {
    const cycle = visit(node.id);
    if (cycle) return cycle;
  }
  return undefined;
}

function nodeFromSpec(spec: TaskNodeSpec, order: number): TaskNode {
  return { id: spec.id, goal: spec.goal.trim(), owner: spec.owner === 'self' ? 'self' : 'agent', after: [...(spec.after ?? [])], order, state: 'pending', generation: 1,
    ...(spec.needs ? { needs: structuredClone(spec.needs) } : {}), ...(spec.role ? { role: spec.role } : {}), ...(spec.start ? { start: [...spec.start] } : {}), ...(spec.scope ? { scope: [...spec.scope] } : {}), ...(spec.check ? { check: spec.check } : {}), ...(spec.acceptance ? { acceptance: spec.acceptance } : {}) };
}

/** Validate against the graph and, when supplied, current filesystem paths without changing either. */
export function planTaskDeclaration(graph: TaskGraph, declaration: TaskDeclaration, options: TaskDeclareOptions = {}): { graph: TaskGraph; errors: string[] } {
  const errors: string[] = [];
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const declared = new Set<string>();
  for (const id of declaration.remove ?? []) {
    const node = nodes.get(id);
    if (!node) errors.push(`task ${JSON.stringify(id)}: cannot remove an unknown task`);
    else if (!taskNodeUnstarted(node)) errors.push(`task ${JSON.stringify(id)}: only unstarted tasks can be removed; use drop instead`);
    else nodes.delete(id);
  }
  let order = Math.max(0, ...graph.nodes.map(node => node.order + 1));
  for (const spec of declaration.tasks) {
    errors.push(...taskSpecErrors(spec, options));
    if (declared.has(spec.id)) { errors.push(`task ${JSON.stringify(spec.id)}: declared twice in one call`); continue; }
    declared.add(spec.id);
    const existing = nodes.get(spec.id);
    if (existing && !taskNodeUnstarted(existing)) { errors.push(`task ${JSON.stringify(spec.id)}: already started; use resume or redo`); continue; }
    if (declaration.remove?.includes(spec.id)) { errors.push(`task ${JSON.stringify(spec.id)}: cannot be removed and declared in one call`); continue; }
    nodes.set(spec.id, nodeFromSpec(spec, existing?.order ?? order++));
  }
  for (const node of nodes.values()) for (const id of node.after) if (!nodes.has(id)) errors.push(`task ${JSON.stringify(node.id)}: after references unknown task ${JSON.stringify(id)}`);
  const next = [...nodes.values()].sort((left, right) => left.order - right.order);
  const cycle = errors.length ? undefined : findTaskCycle(next);
  if (cycle) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
  const limit = options.maxTaskNodes ?? defaultMaxTaskNodes;
  if (next.length > limit) errors.push(`task graph would have ${next.length} tasks; the session limit is ${limit}`);
  return { graph: { ownerId: graph.ownerId, nodes: next }, errors };
}

/**
 * Applies a `delegate` declaration atomically: any validation error rejects the whole call
 * (`TASK_GRAPH_INVALID`) and nothing is written. New and changed nodes start `pending`;
 * the scheduler promotes them once predecessors are integrated.
 */
export function declareTasks(store: Store, ownerId: string, declaration: TaskDeclaration, options: TaskDeclareOptions = {}): TaskGraph {
  return store.transaction(() => {
    const current = readTaskGraph(store, ownerId);
    const owner = store.run(ownerId);
    const { graph, errors } = planTaskDeclaration(current, declaration, { workspace: owner.execution?.root ?? store.session(owner.sessionId).workspace, parentScope: owner.scope, ...options });
    if (errors.length) throw new KodoError('TASK_GRAPH_INVALID', `delegate rejected; no task changed:\n${errors.join('\n')}`);
    for (const id of declaration.remove ?? []) removeTaskNode(store, ownerId, current.nodes.find(node => node.id === id)!);
    for (const spec of declaration.tasks) writeTaskNode(store, ownerId, graph.nodes.find(node => node.id === spec.id)!, { declared: true });
    return graph;
  });
}
