import path from 'node:path';
import type { Store } from '../storage/index.js';
import { KodoError } from './types.js';
import type { Run, Session, ToolRequest } from './types.js';
import { sha256, workspaceManifest } from './execution-snapshot.js';
import { isLeanProfile } from './tool-view.js';
import { checkPassed, parseCheckCommand } from './check-command.js';

export const checkStartedEvent = 'check.started';
export const checkHintedEvent = 'check.repeat_hinted';
export const suitePassedEvent = 'check.suite_passed';
export const repeatedCheckHint = 'This check previously exited 0 on the same recorded workspace version (output filtering and timeout wrappers ignored). This invocation still executes; changed environment or required evidence may justify rechecking.';
export const suitePassedNotice = 'The repository-wide test run passed on the current workspace version. Before delivering, run any other check the project requires (for example coverage, types or lint) that has no final-version result, and finish missing required behavior; alternative interfaces, convenience methods and cleanup are not required. Disclose any required check you could not satisfy.';

interface CheckStart { callId: string; command: string; key: string; cwd: string; version: string | null }

/** Workspace version (6.6) without the private runtime directory, which changes with every event; null when it cannot be established. */
export function checkVersion(store: Store, root: string): string | null {
  let manifest;
  try { manifest = workspaceManifest(root); }
  catch (error) { if (error instanceof KodoError) return null; throw error; }
  const data = path.relative(root, store.directory).replaceAll('\\', '/');
  if (!data || data.startsWith('..') || path.isAbsolute(data)) return manifest.digest;
  const entries = manifest.entries.filter(entry => entry.path !== data && !entry.path.startsWith(`${data}/`));
  return sha256(entries.map(entry => `${entry.mode} ${entry.hash} ${entry.path}\n`).join(''));
}

/** Recorded completion time of a foreground command that exited 0 without cancellation or an unsettled effect. */
function succeededAt(store: Store, runId: string, callId: string, command: string): string | undefined {
  const call = store.call(callId);
  if (call.status !== 'succeeded' || call.effectOutcome === 'unknown' || !call.resultRef) return undefined;
  const result = store.readBlob<{ exitCode?: unknown; timedOut?: unknown; cancelled?: unknown; processId?: unknown; jobId?: unknown }>(call.resultRef);
  if (!result || !checkPassed(command, result) || result.processId || result.jobId) return undefined;
  const finished = store.latestEvent(runId, { types: ['tool.finished'], match: { callId, status: 'succeeded' } });
  return finished && Number.isFinite(Date.parse(finished.time)) && !finished.data.background ? finished.time : undefined;
}

/**
 * No native content write or integration after the earlier check began. Shell commands and successful
 * commits are left to the workspace version; a changed file still invalidates earlier evidence.
 */
function quietSince(store: Store, runId: string, after: number, ignore: ReadonlySet<string>): boolean {
  if (store.hasEvent(runId, { types: ['execution.integrated'], after })) return false;
  return store.events(runId, { types: ['tool.started'], after }).every(event => {
    const callId = event.data.callId;
    if (typeof callId !== 'string') return false;
    const call = store.call(callId);
    if (call.name === 'workspace.git' && call.status === 'succeeded' && call.effectOutcome !== 'unknown') {
      const request = store.readBlob<ToolRequest>(call.requestRef);
      if ((JSON.parse(request.arguments) as { action?: string }).action === 'commit') return true;
    }
    return ignore.has(callId) || call.effect !== 'write' || call.name === 'shell.exec';
  });
}

/**
 * Record a lean `bash` command with its workspace version, and return a main-run repeated-check
 * hint (7.2) when the same command in the same directory last succeeded on the same version with no write since.
 * Called while the command's workspace lock is held. Evidence that cannot be established never yields a hint.
 */
export function recordCheckStart(store: Store, run: Run, session: Session, callId: string, command: string): string | undefined {
  if (!isLeanProfile(store.session(run.sessionId).toolProfile)) return undefined;
  const parsed = parseCheckCommand(command);
  const key = parsed?.key ?? command;
  // A compound command may edit files before its check. Its invocation-time hash is not check evidence.
  // Keep the event for auditing, but avoid a workspace scan when the check cannot be isolated.
  const start: CheckStart = { callId, command, key, cwd: session.workspace, version: parsed ? checkVersion(store, session.workspace) : null };
  const previous = store.latestEvent(run.id, { types: [checkStartedEvent], match: { key, cwd: start.cwd } });
  store.event(run.id, checkStartedEvent, { ...start });
  if (run.parentId) return undefined;
  if (!previous || start.version === null) return undefined;
  const earlier = previous.data as unknown as CheckStart;
  const previousSucceededAt = succeededAt(store, run.id, earlier.callId, earlier.command);
  if (earlier.version !== start.version || !previousSucceededAt || !quietSince(store, run.id, previous.seq, new Set([earlier.callId, callId]))) return undefined;
  if (store.hasEvent(run.id, { types: [checkHintedEvent], match: { key, version: start.version } })) return undefined;
  store.event(run.id, checkHintedEvent, { callId, previous: earlier.callId, previousSucceededAt, command, key, version: start.version });
  const prior = store.call(earlier.callId);
  const result = store.readBlob<{ outputArtifact?: { id?: string; capturedComplete?: boolean } }>(prior.resultRef!);
  const artifact = result.outputArtifact;
  return `${repeatedCheckHint} Previous success: ${previousSucceededAt}.${artifact?.id ? ` Previous captured output: read ${JSON.stringify({ artifact: artifact.id })} (capturedComplete: ${artifact.capturedComplete === true}). Read it for details instead of rerunning to change the output view.` : ''}`;
}

/**
 * One notice per main lean run, the first time a foreground whole-suite test command visibly passes:
 * by its own exit code, or by a final printed status. Unrecognized commands never produce it; nothing is blocked.
 */
export function recordSuitePass(store: Store, run: Run, callId: string, command: string, result: unknown): string | undefined {
  if (run.parentId || !isLeanProfile(store.session(run.sessionId).toolProfile)) return undefined;
  const value = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  if (value.background !== undefined || !checkPassed(command, value)) return undefined;
  if (!parseCheckCommand(command)?.wholeSuite || store.hasEvent(run.id, { types: [suitePassedEvent] })) return undefined;
  const start = store.latestEvent(run.id, { types: [checkStartedEvent], match: { callId } });
  const version = start?.data.version;
  const cwd = start?.data.cwd;
  if (typeof version !== 'string' || typeof cwd !== 'string' || checkVersion(store, cwd) !== version) return undefined;
  store.event(run.id, suitePassedEvent, { callId, command, version });
  return suitePassedNotice;
}
