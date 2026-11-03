import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import path from 'node:path';
import { KodoError } from './types.js';
import type { FileScope, Run } from './types.js';
import { changedExecutionFiles, executionFileViolation, git, protectedPath } from './execution-workspace.js';
import { workspaceManifest } from './workspace-manifest.js';
import type { WorkspaceManifest } from './workspace-manifest.js';

export { indexModes, sha256, workspaceManifest } from './workspace-manifest.js';
export type { FileMode, ManifestEntry, WorkspaceManifest } from './workspace-manifest.js';
export interface SnapshotTarget { sourceRoot: string; sessionId: string; nodeId: string; generation: number; childId: string }
export interface ExecutionSnapshotRecord {
  commit: string; ref: string; sourceHead: string | null; manifestDigest: string;
  files: number; excluded: number; attempts: number; reused: { ref: boolean; checkout: boolean };
}
export interface ExecutionSnapshot { record: ExecutionSnapshotRecord; execution: NonNullable<Run['execution']>; manifest: WorkspaceManifest }
export interface SnapshotOptions { attempts?: number; /** Test seam: runs after the commit is written, before the external-change recheck. */ beforeVerify?: (attempt: number) => void }

const identifier = /^[a-zA-Z0-9-]+$/u;
const identity = ['-c', 'user.name=Kodo', '-c', 'user.email=kodo@localhost', '-c', 'commit.gpgsign=false'];
// Fixed dates keep the snapshot commit a pure function of tree, parent and name, so recovery can reuse it.
const fixedDates = { GIT_AUTHOR_DATE: '@0 +0000', GIT_COMMITTER_DATE: '@0 +0000' };
export const snapshotRef = (sessionId: string, nodeId: string, generation: number): string => `refs/kodo/snapshots/${sessionId}/${nodeId}-${generation}`;
export const snapshotCheckoutRoot = (sourceRoot: string, sessionId: string, childId: string): string => path.join(path.dirname(sourceRoot), '.kodo-executions', sessionId, childId);

// Capture-only helpers; they move out of the codebase with S2 (isolated checkout removal).
function snapshotPaths(root: string): { files: string[]; excluded: number } {
  const listed = [...new Set(git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))];
  const files = listed.filter(file => !protectedPath(file)).sort();
  return { files, excluded: listed.length - files.length };
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

function snapshotLink(root: string, file: string): string {
  const target = readlinkSync(path.join(root, file));
  const relative = (absolute: string): string => path.relative(root, absolute).split(path.sep).join('/');
  const permitted = (value: string): boolean => value !== '..' && !value.startsWith('../') && !path.isAbsolute(value) && !protectedPath(value);
  if (path.isAbsolute(target) || !permitted(relative(path.resolve(root, path.dirname(file), target)))) throw new KodoError('EXECUTION_FILE', `snapshot link must remain in the ordinary workspace: ${file}`);
  let resolved: string;
  try { resolved = relative(realpathSync(path.join(root, file))); }
  catch { throw new KodoError('EXECUTION_FILE', `snapshot link target must exist and resolve without a cycle: ${file}`); }
  if (!permitted(resolved)) throw new KodoError('EXECUTION_FILE', `snapshot link must resolve in the ordinary workspace: ${file}`);
  return target;
}

/** Workspace version (6.6): digest of the snapshot file set's hash manifest. */
export function workspaceVersion(root: string): string { return workspaceManifest(root).digest; }

function sourceHead(root: string): string | null {
  try { return git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']).trim(); }
  catch (error) { if (error instanceof KodoError) return null; throw error; }
}

/** Writes blobs, tree and commit through a temporary index; undefined when a file changed while it was hashed. */
function writeSnapshotCommit(root: string, target: SnapshotTarget): { commit: string; head: string | null; manifest: WorkspaceManifest } | undefined {
  const manifest = workspaceManifest(root);
  const index = path.join(root, '.kodo', 'snapshots', `${target.nodeId}-${target.generation}.index`);
  mkdirSync(path.dirname(index), { recursive: true });
  rmSync(index, { force: true });
  try {
    const { entries } = manifest;
    // --no-filters stores the exact working bytes, so the child diff applies to the same bytes later.
    const regular = entries.filter(entry => entry.mode !== '120000');
    const blobs = regular.length ? git(root, ['hash-object', '-w', '--no-filters', '--stdin-paths'], regular.map(entry => `${entry.path}\n`).join('')).split('\n').filter(Boolean) : [];
    if (blobs.length !== regular.length || blobs.some((blob, i) => blob !== regular[i]!.blob)) return undefined;
    for (const entry of entries.filter(entry => entry.mode === '120000')) {
      if (git(root, ['hash-object', '-w', '--stdin'], entry.linkTarget).trim() !== entry.blob) return undefined;
    }
    const env = { GIT_INDEX_FILE: index };
    git(root, ['update-index', '-z', '--index-info'], entries.map(entry => `${entry.mode} ${entry.blob}\t${entry.path}\0`).join(''), env);
    const tree = git(root, ['write-tree'], undefined, env).trim();
    const head = sourceHead(root);
    const message = `kodo snapshot ${target.sessionId}/${target.nodeId}-${target.generation}`;
    const commit = git(root, [...identity, 'commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message], undefined, fixedDates).trim();
    return { commit, head, manifest };
  } finally { rmSync(index, { force: true }); }
}

/** True when no manifest file changed size or mtime and no new snapshot path appeared. */
function unchangedSince(root: string, manifest: WorkspaceManifest): boolean {
  const known = new Set(manifest.entries.map(entry => entry.path));
  for (const file of snapshotPaths(root).files) if (!known.has(file) && existsSync(path.join(root, file))) return false;
  return manifest.entries.every(entry => {
    try { const stat = lstatSync(path.join(root, entry.path)); return (entry.mode === '120000' ? stat.isSymbolicLink() && snapshotLink(root, entry.path) === entry.linkTarget : stat.isFile()) && stat.size === entry.size && stat.mtimeMs === entry.mtimeMs; }
    catch (error) { if (missing(error)) return false; throw error; }
  });
}

/** Points the snapshot ref at the commit; true when it already did. */
function writeRef(root: string, ref: string, commit: string): boolean {
  let current: string | undefined;
  try { current = git(root, ['rev-parse', '--verify', '-q', ref]).trim(); }
  catch (error) { if (!(error instanceof KodoError)) throw error; }
  if (current === commit) return true;
  git(root, ['update-ref', ref, commit]);
  return false;
}

/**
 * Snapshot the workspace (tracked and unignored files, protected paths excluded) into a persistent ref and
 * a checkout descriptor, leaving the user's HEAD, index and files unchanged. Caller holds the workspace write lock.
 * The persistent ref pins the objects while checkout preparation proceeds outside the source lock.
 */
export function captureExecutionSnapshot(target: SnapshotTarget, options: SnapshotOptions = {}): ExecutionSnapshot {
  if (![target.sessionId, target.nodeId, target.childId].every(value => identifier.test(value)) || !Number.isSafeInteger(target.generation) || target.generation < 0) throw new KodoError('EXECUTION_ROOT', 'invalid snapshot identity');
  const sourceRoot = realpathSync(target.sourceRoot);
  if (realpathSync(git(sourceRoot, ['rev-parse', '--show-toplevel']).trim()) !== sourceRoot) throw new KodoError('EXECUTION_ROOT', 'isolated execution requires the workspace to be the repository root');
  const ref = snapshotRef(target.sessionId, target.nodeId, target.generation);
  const attempts = options.attempts ?? 3;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const written = writeSnapshotCommit(sourceRoot, target);
    if (!written) continue;
    options.beforeVerify?.(attempt);
    if (!unchangedSince(sourceRoot, written.manifest)) continue;
    const execution: NonNullable<Run['execution']> = { kind: 'clone', root: snapshotCheckoutRoot(sourceRoot, target.sessionId, target.childId), sourceRoot, baseCommit: written.commit };
    const reused = { ref: writeRef(sourceRoot, ref, written.commit), checkout: false };
    const { manifest } = written;
    return { execution, manifest, record: { commit: written.commit, ref, sourceHead: written.head, manifestDigest: manifest.digest, files: manifest.entries.length, excluded: manifest.excluded, attempts: attempt, reused } };
  }
  throw new KodoError('EXECUTION_SNAPSHOT_CHANGED', `the workspace was modified externally during the snapshot (${attempts} attempts)`);
}

export interface HostCommitViolation { path: string; code: string; message: string }
export type HostCommitResult =
  | { status: 'committed' | 'unchanged'; commit: string; baseCommit: string; files: string[]; ignored: string[] }
  | { status: 'rejected'; violations: HostCommitViolation[]; ignored: string[] };

/**
 * Host commit of a finished child checkout (6.4). Reports every protected, out-of-scope or non-regular path
 * instead of stopping at the first, and lists ignored new files, which are never committed.
 */
export function hostCommitExecution(execution: NonNullable<Run['execution']>, scope: FileScope | undefined, message: string, markStarted: () => void = () => {}): HostCommitResult {
  const { root, baseCommit } = execution;
  const files = changedExecutionFiles(root);
  const violations = files.flatMap(file => {
    const violation = executionFileViolation(scope, root, file);
    return violation ? [{ path: file, code: violation.code, message: violation.message }] : [];
  });
  const ignored = git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']).split('\0').filter(Boolean);
  if (violations.length) return { status: 'rejected', violations, ignored };
  if (files.length) {
    markStarted();
    // update-index, unlike a pathspec `git add`, accepts paths whose deletion is already staged.
    git(root, ['update-index', '--add', '--remove', '-z', '--stdin'], files.map(file => `${file}\0`).join(''));
    git(root, [...identity, 'commit', '--no-verify', '-m', message]);
  }
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  if (commit === baseCommit) return { status: 'unchanged', commit, baseCommit, files: [], ignored };
  // Includes commits a legacy worker made itself, so the list matches the delivery diff.
  const delivered = git(root, ['diff', '--name-only', '--no-renames', '-z', baseCommit, commit, '--']).split('\0').filter(Boolean);
  return { status: 'committed', commit, baseCommit, files: delivered, ignored };
}
