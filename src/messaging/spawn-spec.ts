import type { Store } from '../storage/index.js';
import { KodoError, terminal } from '../runtime/types.js';
import type { CardModelRole, FileScope, ModelBinding, Permission, Run, ToolSpec } from '../runtime/types.js';
import { validateModelBinding } from '../providers/model-limits.js';
import { writeScopesOverlap } from '../runtime/scope.js';
import { recoveryResolution } from '../runtime/recovery-resolution.js';
import { todoDependenciesSatisfied } from '../runtime/todo-dependencies.js';

const object = (properties: Record<string, unknown>, required = Object.keys(properties)): Record<string, unknown> => ({ type: 'object', additionalProperties: false, properties, required });
const id = { type: 'string', minLength: 1, maxLength: 256 };
const content = { type: 'string', minLength: 1, maxLength: 16_000 };
const taskItems = { type: 'array', items: { type: 'string', minLength: 1, maxLength: 2000 }, maxItems: 16 };
const roots = (description: string) => ({ type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true, maxItems: 256, description });
const modelAlias = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' };

/** Validate host-owned aliases before they become durable session policy or model-visible choices. */
export function validateAgentModelPolicy(bindings?: Record<string, ModelBinding>, descriptions?: Record<string, string>, roles?: Partial<Record<CardModelRole, string>>): void {
  const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const alias = (name: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(name) && !Object.hasOwn(Object.prototype, name);
  if (bindings !== undefined) {
    if (!record(bindings)) throw new KodoError('MODEL_BINDING', 'modelBindings must map approved aliases to model bindings');
    for (const [name, binding] of Object.entries(bindings)) {
      if (!alias(name)) throw new KodoError('MODEL_BINDING', 'model binding aliases require 1-64 letters, digits, hyphens or underscores, starting with a letter or digit, without reserved names');
      if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new KodoError('MODEL_BINDING', 'each model binding alias requires a configured model binding');
      validateModelBinding(binding);
    }
  }
  if (descriptions !== undefined && (!record(descriptions) || Object.entries(descriptions).some(([name, text]) => !bindings || !Object.hasOwn(bindings, name) || typeof text !== 'string' || text.length > 240 || /[\p{Cc}\p{Cf}]/u.test(text)))) throw new KodoError('MODEL_BINDING_DESCRIPTION', 'model descriptions must name approved aliases and contain at most 240 characters without control characters');
  if (roles !== undefined && (!record(roles) || Object.entries(roles).some(([role, name]) => !['fast', 'standard', 'strong'].includes(role) || typeof name !== 'string' || !bindings || !Object.hasOwn(bindings, name)))) throw new KodoError('MODEL_ROLE', 'model roles must name host-approved model binding aliases');
}

/**
 * One delegation tool with two child modes. A fresh child starts from a new
 * initial context; a fork continues a settled child with its exact persisted
 * context prefix, model, permissions and scope, appending only the new task.
 */
export const spawnAgentSpec: ToolSpec & { main: true } = {
  name: 'spawn_agent',
  main: true,
  description: [
    'Run one independent task in a child agent in the shared workspace.',
    'Default is fresh: the child inherits your card and permissions, may only narrow them, and gets a new context with only this task packet.',
    'Pass fork_of with a settled child run ID to continue that child: it keeps the child model, permissions, scope and exact context prefix, appending your new objective.',
    'Use a fresh child for independent black-box review: give it the artifact, paths and acceptance checks, not the implementer conclusions.',
    'Keep working, then wait_for_events with its ID and inspect_run the original evidence before integrating.',
    'Example: {"objective":"Add tests for src/parser.ts","inputs":["parse(text) is exported"],"acceptance":["npx vitest run tests/parser.test.ts passes"],"scope":{"write":["tests"]}}',
  ].join(' '),
  parameters: object({
    objective: { ...content, description: 'One concrete, self-contained goal.' },
    fork_of: { ...id, description: 'A settled managed child run to continue with its exact context prefix, model, permissions and scope.' },
    context: { ...content, description: 'Background and constraints; the child cannot see your history.' },
    inputs: { ...taskItems, description: 'Facts, file paths or artifact IDs to start from.' },
    acceptance: { ...taskItems, description: 'Checks the child should run and report.' },
    permissions: { type: 'array', uniqueItems: true, items: { enum: ['read', 'write', 'exec'] }, description: 'Subset of yours; omit to inherit. A fork keeps the source permissions.' },
    model_binding: { ...modelAlias, description: 'Approved alias; omit to inherit. A fork keeps the source model.' },
    scope: object({
      read: roots('Relative roots, e.g. "src"; omit to inherit.'),
      write: roots('Relative roots, e.g. "tests"; omit to inherit; [] denies writes.'),
    }, []),
  }, ['objective']),
};

export interface SpawnAgentRequest {
  objective: string; fork_of?: string; context?: string;
  inputs?: string[]; acceptance?: string[];
  permissions?: Permission[]; model_binding?: string; scope?: FileScope;
}

/** Keep unfinished work counted through cancellation and effect reconciliation. */
export function childIsActive(store: Store, child: Run): boolean {
  return !terminal(child.status) || store.calls(child.id).some(call => {
    if (call.kind !== 'tool' || !['planned', 'running', 'unknown'].includes(call.status)) return false;
    if (call.effect !== 'write' || call.status === 'planned') return true;
    const resolution = recoveryResolution(store, child.id, call.id);
    // Terminal source calls are immutable. A definite settlement releases their
    // slot even if not_applied permits a later retry in a separate live run.
    return !resolution || !['succeeded', 'failed', 'not_applied'].includes(resolution.outcome);
  });
}

export function childCapacity(store: Store, sessionId: string) {
  const { budget } = store.session(sessionId);
  const children = store.listRuns(sessionId).filter(child => child.parentId);
  const activeRunIds = children.filter(child => childIsActive(store, child)).map(child => child.id);
  const cumulative = budget.maxChildren === null ? Infinity : Math.max(0, budget.maxChildren - children.length);
  const active = budget.maxActiveChildren === undefined ? Infinity : Math.max(0, budget.maxActiveChildren - activeRunIds.length);
  const remaining = Math.min(cumulative, active);
  return { maximum: budget.maxChildren, maximumActive: budget.maxActiveChildren ?? null, created: children.length, active: activeRunIds.length,
    remaining: Number.isFinite(remaining) ? remaining : null, remainingActive: Number.isFinite(active) ? active : null, activeRunIds };
}

export function assertChildCapacity(store: Store, sessionId: string, count = 1): void {
  const capacity = childCapacity(store, sessionId);
  if (capacity.maximum !== null && capacity.created + count > capacity.maximum) throw new KodoError('CHILD_BUDGET', `session child creation limit reached (${capacity.created}/${capacity.maximum}, including finished runs and forks)`);
  if (capacity.remainingActive !== null && count > capacity.remainingActive) throw new KodoError('CHILD_CAPACITY', `active child limit reached (${capacity.active}/${capacity.maximumActive}); wait for tasks to finish. Active run IDs: ${capacity.activeRunIds.join(', ')}`);
}

/** Creation capacity and shared spending as seen by one run. */
export function delegationState(store: Store, run: Run) {
  const session = store.session(run.sessionId);
  const children = childCapacity(store, session.id);
  // A child needs at least one model call of its own on top of the main agent's next turn.
  const sharedExhausted = (session.budget.maxModelCalls !== null && session.modelCalls + 2 > session.budget.maxModelCalls) || (session.budget.maxTokens !== null && session.tokens >= session.budget.maxTokens);
  return {
    canSpawn: !run.parentId && !terminal(run.status) && run.status !== 'interrupted' && !run.cancelRequested && !run.interruptRequested && (children.remaining === null || children.remaining > 0) && !sharedExhausted,
    children,
    sharedBudget: { modelCallsRemaining: session.budget.maxModelCalls === null ? null : Math.max(0, session.budget.maxModelCalls - session.modelCalls), tokensRemaining: session.budget.maxTokens === null ? null : Math.max(0, session.budget.maxTokens - session.tokens), toolCallsRemaining: session.budget.maxToolCalls === null ? null : Math.max(0, session.budget.maxToolCalls - session.toolCalls), maxConcurrentModels: session.budget.maxConcurrentModels },
    budgetPolicy: 'canSpawn reports role, active capacity, any explicit cumulative creation cap and shared spending; admission is checked again atomically. Null means no configured limit. Finished settled tasks release active capacity; every new run, including a fork, counts toward an explicitly configured cumulative cap. Model concurrency is separate.',
    resultPolicy: 'Wait for terminal evidence, inspect_run for managed child results and tool evidence, then independently check acceptance. A completed child is not a verified deliverable.',
  };
}

/**
 * Children share one workspace, so two live writers may not claim overlapping write
 * scopes; a directory overlaps every file under it. A claim is a write scope narrower
 * than the parent's: an unscoped or inherited scope shares the workspace by choice.
 * The error names the holder so the parent can wait for it, cancel it or pick a disjoint scope.
 */
export function assertNoWriteConflict(store: Store, parent: Run, permissions: Permission[], scope: FileScope, strict = false): void {
  const inherited = JSON.stringify([...parent.scope?.write ?? []].sort());
  const claims = (candidate: FileScope | undefined): boolean => strict ? candidate?.write === undefined || candidate.write.length > 0 : Boolean(candidate?.write?.length) && JSON.stringify([...candidate!.write!].sort()) !== inherited;
  if (!permissions.includes('write') || !claims(scope)) return;
  const sessionPermissions = store.session(parent.sessionId).permissions;
  const holder = store.listRuns(parent.sessionId).find(peer => peer.parentId === parent.id && !terminal(peer.status) && !peer.cancelRequested
    && (peer.status !== 'queued' || todoDependenciesSatisfied(store, parent.id, peer.todo))
    && (peer.permissions ?? sessionPermissions).includes('write') && claims(peer.scope) && writeScopesOverlap(peer.scope, scope));
  if (!holder) return;
  throw new KodoError('WRITE_SCOPE_CONFLICT', `write scope ${JSON.stringify(scope.write)} overlaps child ${holder.id} (status ${holder.status}), which holds write scope ${JSON.stringify(holder.scope?.write ?? ['.'])}; wait for it, cancel it, or choose a disjoint scope`);
}
