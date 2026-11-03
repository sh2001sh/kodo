import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Store } from '../storage/index.js';
import type { FileState } from '../storage/file-states.js';

/** Files checked for outside changes after each tool batch, most recently observed first. */
export const watchedFiles = 32;

type Observed = { hash: string; size: number; mtimeMs: number };

/** Size and modification time of a regular file, or undefined when it is gone or not a file. */
export async function fileStat(file: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const info = await stat(file);
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : undefined;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}

async function hashFile(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024, ...(signal ? { signal } : {}) })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Records content this run has now seen at `file`. `before` is the stat taken before
 * the content was read, so a change during the read leaves an older mtime and is
 * detected by the next check.
 */
export function recordSeen(store: Store, runId: string, file: string, hash: string, before: { size: number; mtimeMs: number } | undefined): void {
  if (!before) return;
  store.fileStates.put(runId, file, { hash, size: before.size, mtimeMs: before.mtimeMs });
}

/** Records a file this run just wrote natively; its new content counts as seen. */
export async function recordWritten(store: Store, runId: string, file: string, hash: string): Promise<void> {
  const after = await fileStat(file);
  if (after) store.fileStates.put(runId, file, { hash, ...after });
  else store.fileStates.remove(runId, file);
}

/** The run's last seen state of `file` when it no longer matches `currentHash`. */
export function staleState(store: Store, runId: string, file: string, currentHash: string | null): FileState | undefined {
  // Creating a file that is absent now cannot overwrite content the run has not seen.
  if (currentHash === null) return undefined;
  const seen = store.fileStates.get(runId, file);
  return seen && seen.hash !== currentHash ? seen : undefined;
}

/**
 * Workspace-relative paths of files this run saw whose content changed by other means
 * since, each reported once per new content. Unchanged stat skips hashing.
 */
export async function changedSinceSeen(store: Store, runId: string, workspace: string, signal?: AbortSignal): Promise<string[]> {
  const changed: string[] = [];
  for (const seen of store.fileStates.recent(runId, watchedFiles)) {
    signal?.throwIfAborted();
    const current = await fileStat(seen.path);
    if (current && current.size === seen.size && current.mtimeMs === seen.mtimeMs) continue;
    let observed: Observed | { hash: null; size: number; mtimeMs: number };
    if (!current) observed = { hash: null, size: -1, mtimeMs: -1 };
    else {
      let hash: string;
      try { hash = await hashFile(seen.path, signal); }
      catch (error) {
        if (signal?.aborted) throw error;
        // A file that vanished or became unreadable while hashing is reported by the next check.
        continue;
      }
      observed = { hash, ...current };
    }
    if (observed.hash === seen.hash) { store.fileStates.refreshStat(runId, seen.path, seen.hash, current!); continue; }
    const marker = observed.hash ?? 'absent';
    if (seen.notifiedHash === marker) continue;
    store.fileStates.markNotified(runId, seen.path, { hash: marker, size: observed.size, mtimeMs: observed.mtimeMs });
    changed.push(path.relative(workspace, seen.path).replaceAll('\\', '/'));
  }
  return changed;
}

/** Notice text for files that changed after this run last saw them. */
export function changedFilesNotice(paths: readonly string[]): string {
  return `Files changed outside this run's native file tools since it last read or wrote them: ${paths.map(item => JSON.stringify(item)).join(', ')}. Re-read a file with file.read before editing it; writes with an earlier hash are rejected.`;
}
