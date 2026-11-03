import type { Store } from '../storage/index.js';
import type { Session } from './types.js';
import { KodoError } from './types.js';

const LEGACY_PROFILE = 'lean-team';
/** Events only the deleted isolated-checkout subsystem could produce. */
const LEGACY_EXECUTION_EVENTS = ['execution.snapshot.captured', 'execution.prepared', 'execution.integrated', 'execution.committed'] as const;
/** Roster-era default cards carried a `-roster-<digest>` identity suffix. */
const LEGACY_ROSTER_CARD = /-roster(?:-[a-f0-9]{12})?$/u;

/**
 * A lean-team session predates this build: its tool profile and task graph size
 * budget only exist in data written by the deleted scheduler. Persisted JSON is
 * intentionally still readable (only old records can carry these fields), so the
 * gate reads the raw record shape instead of the narrowed session type.
 */
export function isLegacyLeanSession(session: Session): boolean {
  const legacy = session as unknown as Record<string, unknown>;
  return legacy.toolProfile === LEGACY_PROFILE || legacy.maxTaskNodes !== undefined;
}

/**
 * Runs and session events written by the deleted isolated-checkout subsystem.
 * This build can no longer create these markers, so one scan per session is
 * cached; only external data edits could invalidate it.
 */
const executionScans = new WeakMap<Store, Map<string, boolean>>();

function scanLegacyExecution(store: Store, sessionId: string): boolean {
  for (const run of store.listRuns(sessionId)) {
    const raw = run as unknown as Record<string, unknown>;
    if (raw.execution !== undefined || raw.executionPending !== undefined) return true;
    if (store.hasEvent(run.id, { types: [...LEGACY_EXECUTION_EVENTS] })) return true;
  }
  return false;
}

export function isLegacyExecutionSession(store: Store, sessionId: string): boolean {
  let scans = executionScans.get(store);
  if (!scans) { scans = new Map(); executionScans.set(store, scans); }
  const cached = scans.get(sessionId);
  if (cached !== undefined) return cached;
  const legacy = scanLegacyExecution(store, sessionId);
  scans.set(sessionId, legacy);
  return legacy;
}

/**
 * Sessions written before the roster/draft/derived-agent subsystems were deleted.
 * The tables are not created by this build, so their rows and the old roster-card
 * identities are read as raw persisted JSON instead of typed records.
 */
const rosterScans = new WeakMap<Store, Map<string, boolean>>();

function scanLegacyRoster(store: Store, sessionId: string): boolean {
  if (store.legacyAgentSession(sessionId)) return true;
  for (const run of store.listRuns(sessionId)) {
    const card = (run as unknown as Record<string, unknown>).card;
    if (!card || typeof card !== 'object' || Array.isArray(card)) continue;
    const record = card as Record<string, unknown>;
    // The roster default was the base card with a `-roster` identity suffix and
    // frozen member references; neither field can be produced by this build.
    if (typeof record.id === 'string' && LEGACY_ROSTER_CARD.test(record.id)) return true;
    if (Array.isArray(record.members) && record.members.length > 0) return true;
  }
  return false;
}

export function isLegacyRosterSession(store: Store, sessionId: string): boolean {
  let scans = rosterScans.get(store);
  if (!scans) { scans = new Map(); rosterScans.set(store, scans); }
  const cached = scans.get(sessionId);
  if (cached !== undefined) return cached;
  const legacy = scanLegacyRoster(store, sessionId);
  scans.set(sessionId, legacy);
  return legacy;
}

/** Events only the deleted explore/followup/todo-dispatch collaboration surface could produce. */
const LEGACY_COLLABORATION_EVENTS = ['exploration.planned', 'agent.followup', 'todo.dispatched', 'todo.dependencies.ready', 'todo.dependencies.changed', 'todo.dependencies.blocked'] as const;
/** Run fields written only by explore, exploration plans, followup identities and todo dispatch. */
const LEGACY_COLLABORATION_FIELDS = ['exploration', 'explore', 'agentId', 'todo'] as const;
const collaborationScans = new WeakMap<Store, Map<string, boolean>>();

function scanLegacyCollaboration(store: Store, sessionId: string): boolean {
  for (const run of store.listRuns(sessionId)) {
    const raw = run as unknown as Record<string, unknown>;
    if (LEGACY_COLLABORATION_FIELDS.some(field => raw[field] !== undefined)) return true;
    if (store.hasEvent(run.id, { types: [...LEGACY_COLLABORATION_EVENTS] })) return true;
  }
  return false;
}

export function isLegacyCollaborationSession(store: Store, sessionId: string): boolean {
  let scans = collaborationScans.get(store);
  if (!scans) { scans = new Map(); collaborationScans.set(store, scans); }
  const cached = scans.get(sessionId);
  if (cached !== undefined) return cached;
  const legacy = scanLegacyCollaboration(store, sessionId);
  scans.set(sessionId, legacy);
  return legacy;
}

/** Session fields written only by the deleted inline-method stages. */
const LEGACY_METHOD_FIELDS = ['inlineMethods', 'methodUnloading', 'methodTools', 'methodSkills', 'methodToolView', 'methodCards'] as const;
/** Events only method loading, ending and checkpoint unloading could produce. */
const LEGACY_METHOD_EVENTS = ['method.loaded', 'method.ended', 'context.methods.unloaded'] as const;
const methodScans = new WeakMap<Store, Map<string, boolean>>();

function scanLegacyMethods(store: Store, sessionId: string): boolean {
  for (const run of store.listRuns(sessionId)) {
    if ((run as unknown as Record<string, unknown>).taskNode !== undefined) return true;
    if (store.hasEvent(run.id, { types: [...LEGACY_METHOD_EVENTS] })) return true;
  }
  return false;
}

/** Inline-method sessions: the raw session record carries a method policy, or a run used stages. */
export function isLegacyMethodSession(store: Store, session: Session): boolean {
  const raw = session as unknown as Record<string, unknown>;
  if (LEGACY_METHOD_FIELDS.some(field => raw[field] !== undefined)) return true;
  let scans = methodScans.get(store);
  if (!scans) { scans = new Map(); methodScans.set(store, scans); }
  const cached = scans.get(session.id);
  if (cached !== undefined) return cached;
  const legacy = scanLegacyMethods(store, session.id);
  scans.set(session.id, legacy);
  return legacy;
}

/**
 * Old isolated-checkout, lean-team, roster, collaboration and inline-method sessions stay visible through
 * read-only APIs but must not execute or create children: silently degrading them
 * to the legacy behavior would change the task's accepted semantics without the
 * author's knowledge. The product is not yet released, so the explicit
 * incompatibility error is the compatibility policy.
 */
export function assertSessionCompatible(store: Store, session: Session): void {
  const execution = isLegacyExecutionSession(store, session.id);
  const lean = isLegacyLeanSession(session);
  const roster = isLegacyRosterSession(store, session.id);
  const collaboration = isLegacyCollaborationSession(store, session.id);
  const methods = isLegacyMethodSession(store, session);
  if (!execution && !lean && !roster && !collaboration && !methods) return;
  const reason = execution
    ? 'This session uses the deleted isolated-checkout execution subsystem and is not compatible with this version.'
    : lean
      ? 'This session was created by the deleted lean-team task graph and is not compatible with this version.'
      : roster
        ? 'This session was created by the deleted agent-roster subsystem (roster snapshots, derived agents or retention drafts) and is not compatible with this version.'
        : collaboration
          ? 'This session used deleted collaboration tools (explore, exploration plans, followup tasks or todo dispatch) and is not compatible with this version.'
          : 'This session used deleted inline-method stages (card methods, task stages or method unloading) and is not compatible with this version.';
  throw new KodoError('SESSION_INCOMPATIBLE', `${reason} The product has not shipped; start a new task (use \`kodo inspect\` if the old evidence must be kept).`);
}
