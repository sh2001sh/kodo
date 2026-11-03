import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Store } from '../storage/index.js';
import type { CheckpointState } from '../storage/checkpoints.js';
import { acquireWriteLock, defaultLockDirectory } from '../tools/write-locks.js';
import { recordWritten } from '../tools/read-state.js';
import { actualPath, assertFileScope } from './scope.js';
import { workspacesOverlap } from './paths.js';
import { errorText, KodoError, terminal } from './types.js';

export interface RewindOptions { signal?: AbortSignal; lockDirectory?: string | false; assertIdle?: () => void }
export interface RewindResult { runId: string; toStep: number; rewound: number; paths: string[] }
type Body = { bytes: Buffer; mode: number };
const hash = (value: Buffer): string => createHash('sha256').update(value).digest('hex');
const samePath = (left: string, right: string): boolean => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;

async function inspect(file: string): Promise<CheckpointState> {
  let info;
  try { info = await lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }; throw error; }
  if (info.isDirectory()) return { kind: 'directory' };
  if (!info.isFile()) throw new KodoError('REWIND_TYPE', 'rewind only restores regular files and directories');
  if (info.size > 16 * 1024 * 1024) throw new KodoError('REWIND_LIMIT', 'current file is larger than the native checkpoint limit');
  const bytes = await readFile(file);
  return { kind: 'file', hash: hash(bytes), bytes: bytes.length };
}
function matches(left: CheckpointState, right: CheckpointState): boolean {
  return left.kind === right.kind && (left.kind !== 'file' || right.kind === 'file' && left.hash === right.hash && left.bytes === right.bytes);
}
function bodyOf(store: Store, state: CheckpointState): Body | undefined {
  if (state.kind !== 'file') return;
  if (!state.contentRef) throw new KodoError('REWIND_CONTENT', 'the retained checkpoint has no original file contents');
  const body = store.readBlob<{ encoding: string; content: string; mode?: number }>(state.contentRef);
  if (body.encoding !== 'base64' || typeof body.content !== 'string') throw new KodoError('REWIND_CONTENT', 'checkpoint body is not a file snapshot');
  const bytes = Buffer.from(body.content, 'base64');
  if (bytes.length !== state.bytes || hash(bytes) !== state.hash) throw new KodoError('REWIND_CONTENT', 'checkpoint content does not match its recorded digest');
  return { bytes, mode: (state.mode ?? body.mode ?? 0o600) & 0o777 };
}
async function replace(file: string, body: Body): Promise<void> {
  const temporary = path.join(path.dirname(file), `.kodo-rewind-${randomUUID()}.tmp`);
  const descriptor = await open(temporary, 'wx', body.mode);
  let moved = false;
  try {
    try { await descriptor.writeFile(body.bytes); await descriptor.sync(); }
    finally { await descriptor.close(); }
    await rename(temporary, file);
    moved = true;
  } finally {
    if (!moved) await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
}

/** Restore file state after `toStep`; -1 means before the first step. Execution history is retained. */
export async function rewindRun(store: Store, runId: string, toStep: number, options: RewindOptions = {}): Promise<RewindResult> {
  const run = store.run(runId);
  const session = store.session(run.sessionId);
  if (!session.permissions.includes('write') || !(run.permissions ?? session.permissions).includes('write')) throw new KodoError('REWIND_PERMISSION', 'rewind requires the run and session write grant');
  if (!Number.isSafeInteger(toStep) || toStep < -1 || toStep > run.step) throw new KodoError('REWIND_STEP', 'rewind step must be -1 or an executed step of this run');
  const floor = store.checkpoints.floor(runId);
  if (floor !== undefined && toStep < floor) throw new KodoError('REWIND_HISTORY', `checkpoints before step ${floor} are no longer retained`);
  const checkpoints = store.checkpoints.list(runId).filter(checkpoint => {
    if (checkpoint.step <= toStep) return false;
    if (checkpoint.after) return true;
    const prepared = store.latestEvent(runId, { types: ['file.recovery.prepared'], match: { id: checkpoint.preparationId } });
    const callId = prepared?.data.callId;
    if (typeof callId !== 'string') return true;
    const call = store.call(callId);
    // Cancellation between preparation and dispatch left no filesystem mutation.
    return call.effectState !== 'not_started' || call.status === 'running';
  });
  const output: RewindResult = { runId, toStep, rewound: checkpoints.length, paths: [] };
  if (!checkpoints.length) return output;
  const expected = new Map<string, CheckpointState>();
  const desired = new Map<string, CheckpointState>();
  for (const checkpoint of checkpoints) {
    if (!checkpoint.after) throw new KodoError('REWIND_UNSETTLED', 'a checkpoint has no completed mutation receipt; reconcile it before rewind');
    for (const [key, file] of Object.entries(checkpoint.paths)) {
      if (!checkpoint.after[key] || !checkpoint.before[key]) throw new KodoError('REWIND_CONTENT', 'checkpoint path states are incomplete');
      if (!expected.has(file)) expected.set(file, checkpoint.after[key]!);
      desired.set(file, checkpoint.before[key]!);
    }
  }
  const files = [...desired.keys()];
  const assertIdle = (): void => {
    const current = store.run(runId);
    if (!terminal(current.status) && current.status !== 'interrupted') throw new KodoError('REWIND_ACTIVE', 'stop the run before rewinding its files');
    for (const peer of store.listRuns()) {
      if (!workspacesOverlap(session.workspace, store.session(peer.sessionId).workspace)) continue;
      if (peer.status === 'running' || store.calls(peer.id).some(call => call.kind === 'tool' && call.effect === 'write' && call.status === 'running')) throw new KodoError('REWIND_ACTIVE', 'workspace execution must settle before rewind');
    }
    if (store.unresolvedWrites(session.workspace, undefined, files).length) throw new KodoError('REWIND_UNSETTLED', 'reconcile overlapping unknown writes before rewind');
    options.assertIdle?.();
  };
  assertIdle();
  const release = await acquireWriteLock(session.workspace, files, {
    directory: options.lockDirectory ?? defaultLockDirectory(), signal: options.signal,
    onEvent: event => store.event(runId, event.type, event.data),
  });
  try {
    assertIdle();
    const bodies = new Map<string, Body>();
    for (const file of files) {
      options.signal?.throwIfAborted();
      assertFileScope(run.scope, 'write', session.workspace, file);
      if (!samePath(actualPath(file), path.resolve(file)) || workspacesOverlap(store.directory, file)) throw new KodoError('REWIND_PATH', 'checkpoint path no longer names its original workspace file');
      if (!matches(await inspect(file), expected.get(file)!)) throw new KodoError('REWIND_CHANGED', `file changed since its last retained native mutation: ${path.relative(session.workspace, file)}`);
      const state = desired.get(file)!;
      const body = bodyOf(store, state);
      if (body) bodies.set(file, body);
      // Removing a directory must not remove unrelated files added outside this run.
      if (state.kind === 'absent' && expected.get(file)!.kind === 'directory') {
        const children = await readdir(file);
        if (children.some(child => desired.get(path.join(file, child))?.kind !== 'absent')) throw new KodoError('REWIND_CHANGED', 'a directory to remove contains files outside the rewind');
      }
    }
    store.event(runId, 'file.rewind.started', { toStep, checkpoints: checkpoints.map(checkpoint => checkpoint.id), paths: files.map(file => path.relative(session.workspace, file)) });
    const changed: string[] = [];
    try {
      const absent = files.filter(file => desired.get(file)!.kind === 'absent').sort((a, b) => b.length - a.length);
      const directories = files.filter(file => desired.get(file)!.kind === 'directory').sort((a, b) => a.length - b.length);
      const restored = files.filter(file => desired.get(file)!.kind === 'file');
      for (const file of [...absent, ...directories, ...restored]) {
        options.signal?.throwIfAborted();
        const state = desired.get(file)!;
        if (state.kind === 'absent') {
          const current = await inspect(file);
          if (current.kind === 'directory') await rmdir(file);
          else if (current.kind !== 'absent') await unlink(file);
          store.fileStates.remove(runId, file);
        } else if (state.kind === 'directory') {
          const current = await inspect(file);
          if (current.kind === 'absent') await mkdir(file);
          else if (current.kind !== 'directory') throw new KodoError('REWIND_CHANGED', 'directory changed during rewind');
          store.fileStates.remove(runId, file);
        } else {
          await replace(file, bodies.get(file)!);
          await recordWritten(store, runId, file, state.hash);
        }
        changed.push(path.relative(session.workspace, file));
      }
      store.transaction(() => {
        store.checkpoints.deleteAfter(runId, toStep);
        store.event(runId, 'file.rewind.completed', { toStep, rewound: checkpoints.length, paths: changed });
      });
      return { ...output, paths: changed };
    } catch (error) {
      if (store.fault !== undefined) throw store.fault;
      store.event(runId, 'file.rewind.failed', { toStep, restoredPaths: changed, error: errorText(error), note: 'The rewind may be partial. Checkpoints are retained; inspect the recorded paths before continuing.' });
      throw error;
    }
  } finally { release(); }
}
