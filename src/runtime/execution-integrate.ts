import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { KodoError } from './types.js';
import { git, protectedPath } from './execution-workspace.js';
import { indexModes, sha256, workspaceVersion } from './execution-snapshot.js';
import type { FileMode } from './execution-snapshot.js';

/** File state as compared during integration. Windows working trees carry no executable bit, so mode is not compared there. */
export interface FileImage { exists: boolean; hash?: string; mode?: FileMode }
export interface IntegrationPlanFile { path: string; pre: FileImage; post: FileImage & { content?: string } }
/** Serializable integration plan (6.5); `post.content` is base64 so the plan can be persisted before `started`. */
export interface IntegrationPlan { version: 1; callId: string; root: string; baseCommit: string; commit: string; diffHash: string; files: IntegrationPlanFile[] }
export interface IntegrationSource { root: string; baseCommit: string; commit: string; diff: string }
export type IntegrationPlanResult =
  | { status: 'planned'; plan: IntegrationPlan }
  | { status: 'empty' }
  | { status: 'conflict'; files: string[]; message: string };
export type ReconcileResult =
  | { status: 'applied'; version: string; completed: string[] }
  | { status: 'unknown'; files: string[] };

const identifier = /^[a-zA-Z0-9-]+$/u;
const windows = process.platform === 'win32';

export const integrationStaging = (root: string, callId: string): string => path.join(root, '.kodo', 'integrate', callId);

interface RawChange { path: string; oldMode: string; newMode: string }

/** Per-file modes from the child delivery; the raw diff is authoritative even where the filesystem has no mode bits. */
function rawChanges(source: IntegrationSource): RawChange[] {
  const fields = git(source.root, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', source.baseCommit, source.commit, '--']).split('\0');
  const changes: RawChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const match = /^:(\d{6}) (\d{6}) /u.exec(fields[i]!);
    if (!match) break;
    changes.push({ path: fields[i + 1]!, oldMode: match[1]!, newMode: match[2]! });
  }
  return changes;
}

function absolute(root: string, file: string): string {
  if (protectedPath(file) || path.isAbsolute(file) || file.split('/').some(part => part === '..' || part === '')) throw new KodoError('PATH_DENIED', `integration refuses path ${JSON.stringify(file)}`);
  return path.join(root, file);
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }

/** Current destination state of one file; `modes` is the destination index, used only on Windows. */
export function fileImage(root: string, file: string, modes?: Map<string, string>): FileImage {
  const target = absolute(root, file);
  let stat;
  try { stat = lstatSync(target); } catch (error) { if (missing(error)) return { exists: false }; throw error; }
  if (!stat.isFile()) throw new KodoError('EXECUTION_FILE', `integration supports regular files only: ${file}`);
  const mode: FileMode = windows ? (modes?.get(file) === '100755' ? '100755' : '100644') : (stat.mode & 0o100 ? '100755' : '100644');
  return { exists: true, hash: sha256(readFileSync(target)), mode };
}

function sameImage(actual: FileImage, expected: FileImage): boolean {
  if (actual.exists !== expected.exists) return false;
  return !actual.exists || (actual.hash === expected.hash && (windows || actual.mode === expected.mode));
}

/** Apply the diff to copies of the affected files; returns git's error text on conflict. */
function applyInStaging(staging: string, diff: string): string | undefined {
  // The ceiling stops Git from finding the destination repository, which would make apply skip paths outside the cwd.
  const env = { GIT_CEILING_DIRECTORIES: path.dirname(staging) };
  try {
    git(staging, ['apply', '--check', '--binary', '-'], diff, env);
    git(staging, ['apply', '--binary', '-'], diff, env);
    return undefined;
  } catch (error) {
    if (error instanceof KodoError && error.code === 'EXECUTION_GIT') return error.message;
    throw error;
  }
}

function stage(root: string, staging: string, changes: RawChange[]): Map<string, FileImage> {
  const modes = windows ? indexModes(root) : undefined;
  const pre = new Map<string, FileImage>();
  for (const change of changes) {
    const image = fileImage(root, change.path, modes);
    pre.set(change.path, image);
    if (!image.exists) continue;
    const copy = path.join(staging, change.path);
    mkdirSync(path.dirname(copy), { recursive: true });
    writeFileSync(copy, readFileSync(absolute(root, change.path)));
  }
  return pre;
}

function postImage(staging: string, change: RawChange, pre: FileImage): IntegrationPlanFile['post'] {
  const copy = path.join(staging, change.path);
  if (!existsSync(copy)) return { exists: false };
  const content = readFileSync(copy);
  // Keep the destination's mode unless the delivery itself changed it.
  const mode = (change.oldMode !== change.newMode || !pre.exists ? change.newMode : pre.mode) as FileMode;
  return { exists: true, hash: sha256(content), mode, content: content.toString('base64') };
}

/**
 * Compute expected post-images from the destination's actual pre-images (6.5 step 2) without touching the
 * destination: affected files are copied to `.kodo/integrate/<callId>/` and the diff is applied there.
 * Caller holds the destination workspace write lock.
 */
export function planIntegration(source: IntegrationSource, destination: string, callId: string): IntegrationPlanResult {
  if (!identifier.test(callId)) throw new KodoError('EXECUTION_ROOT', 'invalid integration call identity');
  if (!source.diff) return { status: 'empty' };
  const changes = rawChanges(source);
  if (!changes.length) return { status: 'empty' };
  const special = changes.find(change => ![change.oldMode, change.newMode].every(mode => ['000000', '100644', '100755'].includes(mode)));
  if (special) throw new KodoError('EXECUTION_FILE', `integration supports regular file changes only: ${special.path}`);
  const staging = integrationStaging(destination, callId);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    const pre = stage(destination, staging, changes);
    const failure = applyInStaging(staging, source.diff);
    if (failure) return { status: 'conflict', files: changes.map(change => change.path), message: failure };
    const files = changes.map(change => ({ path: change.path, pre: pre.get(change.path)!, post: postImage(staging, change, pre.get(change.path)!) }));
    return { status: 'planned', plan: { version: 1, callId, root: destination, baseCommit: source.baseCommit, commit: source.commit, diffHash: sha256(source.diff), files } };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

/** Remove a leftover staging directory, e.g. when recovery finds the call still `not_started`. */
export function discardIntegrationStaging(destination: string, callId: string): void {
  if (!identifier.test(callId)) throw new KodoError('EXECUTION_ROOT', 'invalid integration call identity');
  rmSync(integrationStaging(destination, callId), { recursive: true, force: true });
}

function removeEmptyParents(root: string, file: string): void {
  for (let directory = path.dirname(path.join(root, file)); directory.length > root.length && directory.startsWith(root); directory = path.dirname(directory)) {
    if (readdirSync(directory).length) return;
    rmdirSync(directory);
  }
}

/** Write one planned post-image: temp file plus rename, or delete. Idempotent. */
function writePostImage(root: string, file: IntegrationPlanFile): void {
  const target = absolute(root, file.path);
  if (!file.post.exists) {
    rmSync(target, { force: true });
    removeEmptyParents(root, file.path);
    return;
  }
  if (file.post.content === undefined) throw new KodoError('EXECUTION_PLAN', `integration plan has no content for ${file.path}`);
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.kodo-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, Buffer.from(file.post.content, 'base64'), { flag: 'wx' });
    if (!windows) chmodSync(temporary, file.post.mode === '100755' ? 0o755 : 0o644);
    renameSync(temporary, target);
  } finally { rmSync(temporary, { force: true }); }
}

function verifyPostImages(root: string, files: IntegrationPlanFile[]): void {
  const modes = windows ? indexModes(root) : undefined;
  const differing = files.filter(file => !sameImage(fileImage(root, file.path, modes), file.post)).map(file => file.path);
  if (differing.length) throw new KodoError('EXECUTION_INTEGRATE_VERIFY', `integrated files do not match the plan: ${differing.join(', ')}`);
}

/**
 * Apply a persisted plan (6.5 step 4–5) without `git apply` in the destination, so the user's index is untouched.
 * Returns the workspace version after integration. Caller holds the destination workspace write lock.
 */
export function applyIntegrationPlan(plan: IntegrationPlan, markStarted: () => void = () => {}, root = plan.root): { version: string; files: string[] } {
  // A plan computed against other pre-images must be recomputed, not forced over newer content.
  const modes = windows ? indexModes(root) : undefined;
  const moved = plan.files.filter(file => !sameImage(fileImage(root, file.path, modes), file.pre)).map(file => file.path);
  if (moved.length) throw new KodoError('EXECUTION_INTEGRATE_STALE', `files changed since the integration plan was computed: ${moved.join(', ')}`);
  markStarted();
  for (const file of plan.files) writePostImage(root, file);
  verifyPostImages(root, plan.files);
  return { version: workspaceVersion(root), files: plan.files.map(file => file.path) };
}

/**
 * Recover a `started` integration from the plan and the files on disk: every file at its post-image → applied;
 * every file at its pre- or post-image → complete the rest, then applied; any other state → unknown, with no writes.
 * Caller holds the destination workspace write lock.
 */
export function reconcileIntegration(plan: IntegrationPlan, root = plan.root): ReconcileResult {
  const modes = windows ? indexModes(root) : undefined;
  const pending: IntegrationPlanFile[] = [];
  const unknown: string[] = [];
  for (const file of plan.files) {
    let actual: FileImage | undefined;
    try { actual = fileImage(root, file.path, modes); } catch (error) { if (!(error instanceof KodoError)) throw error; }
    if (actual && sameImage(actual, file.post)) continue;
    if (actual && sameImage(actual, file.pre)) pending.push(file);
    else unknown.push(file.path);
  }
  if (unknown.length) return { status: 'unknown', files: unknown };
  for (const file of pending) writePostImage(root, file);
  verifyPostImages(root, plan.files);
  return { status: 'applied', version: workspaceVersion(root), completed: pending.map(file => file.path) };
}
