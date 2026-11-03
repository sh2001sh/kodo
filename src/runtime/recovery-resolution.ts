import type { Store } from '../storage/index.js';
import type { RecoveryResolution } from './recovery.js';

/** Pure settlement lookup, also usable by scheduling without loading tool execution. */
export function recoveryResolution(store: Store, runId: string, callId: string): RecoveryResolution | undefined {
  const after = store.latestEvent(runId, { types: ['tool.started'], match: { callId } })?.seq ?? 0;
  return store.latestEvent(runId, { types: ['recovery.resolved'], match: { callId }, after })?.data as unknown as RecoveryResolution | undefined;
}
