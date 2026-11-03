import { closeSync, copyFileSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Store } from '../storage/index.js';
import { actualPath, assertFileScope } from './scope.js';
import { changedExecutionFiles, executionFileViolation, git, protectedPath } from './execution-workspace.js';
import { KodoError } from './types.js';
import type { Run } from './types.js';

export interface WorkspaceGitArgs {
  action: 'status' | 'diff' | 'branch' | 'commit';
  files?: string[];
  expectedHead?: string;
  name?: string;
  message?: string;
}

export const workspaceGitParameters = {
  type: 'object', additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['status', 'diff', 'branch', 'commit'] },
    files: { type: 'array', minItems: 1, maxItems: 128, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 4096 } },
    expectedHead: { type: 'string', pattern: '^[0-9a-f]{40}([0-9a-f]{24})?$' },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    message: { type: 'string', minLength: 1, maxLength: 1000 },
  }, required: ['action'],
  allOf: [
    { if: { properties: { action: { enum: ['diff', 'commit'] } } }, then: { required: ['files'] } },
    { if: { properties: { action: { enum: ['branch', 'commit'] } } }, then: { required: ['expectedHead'] } },
    { if: { properties: { action: { const: 'branch' } } }, then: { required: ['name'] } },
    { if: { properties: { action: { const: 'commit' } } }, then: { required: ['message'] } },
  ],
};

const identity = ['-c', 'user.name=Kodo', '-c', 'user.email=kodo@localhost', '-c', 'commit.gpgsign=false'];
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

/** Worktree diff can invoke clean filters even with --no-textconv. Override every
 * configured driver for this invocation, without changing repository config.
 */
function diffWithoutFilters(root: string, args: string[]): string {
  const keys = git(root, ['config', '--name-only', '--list']).split(/\r?\n/u);
  const drivers = [...new Set(keys.flatMap(key => {
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/u.exec(key);
    return match ? [match[1]!] : [];
  }))];
  const overrides = drivers.flatMap(driver => ['-c', `filter.${driver}.clean=`, '-c', `filter.${driver}.smudge=`, '-c', `filter.${driver}.process=`, '-c', `filter.${driver}.required=false`]);
  return git(root, [...overrides, '--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', ...args]);
}

/** The caller holds the workspace lock and enforces unknown effects / active processes.
 * Only these structured operations may touch the original repository metadata.
 */
export function workspaceGit(store: Store, run: Run, args: WorkspaceGitArgs, markStarted: () => void): unknown {
  if (run.parentId || run.execution || run.executionPending) throw new KodoError('EXECUTION_OWNER', 'original-workspace Git delivery belongs to the main run');
  const session = store.session(run.sessionId);
  const mutates = args.action === 'branch' || args.action === 'commit';
  for (const permission of mutates ? ['read', 'write'] as const : ['read'] as const) {
    if (!session.permissions.includes(permission) || !(run.permissions ?? session.permissions).includes(permission)) throw new KodoError('EXECUTION_PERMISSION', `${permission} permission is required for Git ${args.action}`);
  }
  const root = realpathSync(session.workspace);
  if (!samePath(root, realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim()))) throw new KodoError('EXECUTION_ROOT', 'Git delivery requires the original repository root');
  const head = git(root, ['rev-parse', '--verify', 'HEAD']).trim();
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const readable = (file: string): boolean => {
    if (protectedPath(file) || inside(store.directory, actualPath(path.resolve(root, file)))) return false;
    try { assertFileScope(run.scope, 'read', root, path.resolve(root, file)); return true; }
    catch (error) { if (error instanceof KodoError) return false; throw error; }
  };
  const selected = (): string[] => {
    if (!Array.isArray(args.files) || !args.files.length || args.files.length > 128) throw new KodoError('GIT_FILES', 'provide 1–128 explicit workspace-relative file paths');
    return [...new Set(args.files.map(file => {
      if (typeof file !== 'string' || !file || file.length > 4096 || Array.from(file).some(char => char.charCodeAt(0) < 32) || path.isAbsolute(file) || /^[a-z]:/iu.test(file) || file.replaceAll('\\', '/').split('/').some(part => part === '..' || part === '.')) throw new KodoError('GIT_FILES', 'Git delivery accepts explicit relative files, not directories, globs or parent traversal');
      const normalized = file.replaceAll('\\', '/');
      if (!readable(normalized)) throw new KodoError('PATH_DENIED', 'Git delivery path is protected or outside the readable scope');
      if (!mutates) {
        try {
          const stat = lstatSync(path.resolve(root, normalized));
          if (!stat.isFile() || stat.isSymbolicLink()) throw new KodoError('GIT_FILES', 'diff requires explicit regular files, not directories or symbolic links');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          const entry = git(root, ['--literal-pathspecs', 'ls-tree', head, '--', normalized]);
          if (!/^100(?:644|755) blob /u.test(entry)) throw new KodoError('GIT_FILES', 'diff requires an existing file or a deleted tracked regular file');
        }
      }
      if (mutates) {
        const violation = executionFileViolation(run.scope, root, normalized);
        if (violation) throw violation;
      }
      return normalized;
    }))];
  };
  if (args.action === 'status') return { root, branch, head, files: changedExecutionFiles(root).filter(readable) };
  if (args.action === 'diff') {
    const files = selected();
    const diff = diffWithoutFilters(root, ['HEAD', '--', ...files]);
    return { root, branch, head, files, diff: diff.slice(0, 32_000), truncated: diff.length > 32_000, untracked: git(root, ['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z', '--', ...files]).split('\0').filter(Boolean) };
  }
  if (!mutates) throw new KodoError('GIT_ACTION', 'unsupported Git action');
  if (args.expectedHead !== head) throw new KodoError('GIT_STALE', 'read Git status and supply its current head as expectedHead before changing the repository');
  // Merging/rebasing has another owner; never complete or alter it implicitly.
  const gitDir = realpathSync(path.resolve(root, git(root, ['rev-parse', '--git-dir']).trim()));
  if (['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'].some(file => existsSync(path.join(gitDir, file)))) throw new KodoError('GIT_ACTIVE', 'finish the existing Git operation before delivery');
  if (args.action === 'branch') {
    assertFileScope(run.scope, 'write', root, root);
    assertFileScope(run.scope, 'read', root, root);
    if (!args.name || args.name.length > 200 || args.name.startsWith('-')) throw new KodoError('GIT_BRANCH', 'provide a valid new branch name');
    git(root, ['check-ref-format', `refs/heads/${args.name}`]);
    if (git(root, ['for-each-ref', '--format=%(refname)', `refs/heads/${args.name}`]).trim()) throw new KodoError('GIT_BRANCH', 'the branch already exists; choose a new name');
    markStarted();
    git(root, ['update-ref', `refs/heads/${args.name}`, head, '0'.repeat(head.length)]);
    git(root, ['symbolic-ref', 'HEAD', `refs/heads/${args.name}`]);
    return { root, branch: args.name, head, previousBranch: branch };
  }
  if (branch === 'HEAD') throw new KodoError('GIT_BRANCH', 'create a named branch before committing');
  if (!args.message?.trim() || args.message.length > 1000 || args.message.includes('\0')) throw new KodoError('GIT_MESSAGE', 'provide a nonempty commit message up to 1000 characters');
  const files = selected();
  const changed = new Set(changedExecutionFiles(root));
  if (files.some(file => !changed.has(file))) throw new KodoError('GIT_FILES', 'every selected path must be an individual changed file');
  return commitFiles(root, head, branch, files, args.message, markStarted);
}

/** Two temporary indexes keep unrelated staged contents byte-for-byte unchanged.
 * Raw blobs avoid invoking project-configured clean filters or executable hooks.
 */
function commitFiles(root: string, head: string, branch: string, files: string[], message: string, markStarted: () => void): unknown {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'kodo-delivery-'));
  const commitIndex = path.join(temporary, 'commit-index');
  const finalIndex = path.join(temporary, 'final-index');
  const index = path.resolve(root, git(root, ['rev-parse', '--git-path', 'index']).trim());
  const lock = `${index}.lock`;
  let ownsLock = false;
  try {
    // Reserve Git's normal index lock before inspecting/staging any selected content.
    try { closeSync(openSync(lock, 'wx')); ownsLock = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new KodoError('GIT_ACTIVE', 'Git index is busy; retry after the active Git operation completes'); throw error; }
    if (!existsSync(index)) throw new KodoError('GIT_INDEX', 'repository index is missing');
    copyFileSync(index, finalIndex);
    const commitEnv = { GIT_INDEX_FILE: commitIndex };
    const finalEnv = { GIT_INDEX_FILE: finalIndex };
    git(root, ['read-tree', head], undefined, commitEnv);
    const entries: string[] = [];
    for (const file of files) {
      const absolute = path.join(root, file);
      if (!existsSync(absolute)) { entries.push(`0 ${'0'.repeat(head.length)}\t${file}\0`); continue; }
      const stat = lstatSync(absolute);
      const old = git(root, ['--literal-pathspecs', 'ls-tree', head, '--', file]);
      const mode = process.platform === 'win32' ? (old.startsWith('100755 ') ? '100755' : '100644') : (stat.mode & 0o111 ? '100755' : '100644');
      markStarted();
      const hash = git(root, ['hash-object', '-w', '--no-filters', '--', absolute]).trim();
      entries.push(`${mode} ${hash}\t${file}\0`);
    }
    const content = entries.join('');
    git(root, ['update-index', '-z', '--index-info'], content, commitEnv);
    const tree = git(root, ['write-tree'], undefined, commitEnv).trim();
    if (tree === git(root, ['rev-parse', `${head}^{tree}`]).trim()) throw new KodoError('GIT_EMPTY', 'selected working files do not change HEAD; no commit created');
    git(root, ['update-index', '-z', '--index-info'], content, finalEnv);
    writeFileSync(lock, readFileSync(finalIndex));
    if (git(root, ['symbolic-ref', 'HEAD']).trim() !== `refs/heads/${branch}`) throw new KodoError('GIT_STALE', 'the current branch changed during delivery');
    markStarted();
    const commit = git(root, [...identity, 'commit-tree', tree, '-p', head, '-m', message]).trim();
    git(root, ['update-ref', '-m', message, `refs/heads/${branch}`, commit, head]);
    renameSync(lock, index); ownsLock = false;
    return { root, branch, head: commit, commit, parent: head, files };
  } finally {
    if (ownsLock) rmSync(lock, { force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
}
