import type { Session } from './types.js';
import { KodoError } from './types.js';

const LEGACY_PROFILE = 'lean-team';

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
 * Old lean-team sessions stay visible through read-only APIs but must not execute
 * or create children: silently degrading them to the legacy view would change the
 * task's accepted semantics without the author's knowledge. The product is not yet
 * released, so the explicit incompatibility error is the compatibility policy.
 */
export function assertSessionCompatible(session: Session): void {
  if (!isLegacyLeanSession(session)) return;
  throw new KodoError('SESSION_INCOMPATIBLE', 'This session was created by the deleted lean-team task graph and is not compatible with this version. The product has not shipped; start a new task (use `kodo inspect` if the old evidence must be kept).');
}
