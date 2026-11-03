import type { Store } from '../storage/index.js';
import type { Session } from './types.js';
import { KodoError } from './types.js';

const LEGACY_PROFILE = 'lean-team';
/** Events only the deleted isolated-checkout subsystem could produce. */
const LEGACY_EXECUTION_EVENTS = ['execution.snapshot.captured', 'execution.prepared', 'execution.integrated', 'execution.committed'] as const;

/**
 * A lean-team session predates this build: its tool profile and task-graph size
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
 * Old isolated-checkout and lean-team sessions stay visible through read-only APIs
 * but must not execute or create children: silently degrading them to the legacy
 * behavior would change the task's accepted semantics without the author's
 * knowledge. The product is not yet released, so the explicit incompatibility
 * error is the compatibility policy.
 */
export function assertSessionCompatible(store: Store, session: Session): void {
  const execution = isLegacyExecutionSession(store, session.id);
  const lean = isLegacyLeanSession(session);
  if (!execution && !lean) return;
  const reason = execution
    ? 'This session uses the deleted isolated-checkout execution subsystem and is not compatible with this version.'
    : 'This session was created by the deleted lean-team task graph and is not compatible with this version.';
  throw new KodoError('SESSION_INCOMPATIBLE', `${reason} The product has not shipped; start a new task (use \`kodo inspect\` if the old evidence must be kept).`);
}
