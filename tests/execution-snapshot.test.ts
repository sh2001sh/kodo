import { takeExecutionSnapshot } from '../src/runtime/execution-checkout.js';
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hostCommitExecution, snapshotRef, workspaceVersion } from '../src/runtime/execution-snapshot.js';
import type { SnapshotTarget } from '../src/runtime/execution-snapshot.js';
import { cleanupSessionExecutions, releaseExecutionCheckout } from '../src/runtime/execution-retention.js';
import { applyIntegrationPlan, planIntegration } from '../src/runtime/execution-integrate.js';
import { temp } from './helpers.js';

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', windowsHide: true, env });
const write = (root: string, file: string, content: string): void => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), content); };
const read = (root: string, file: string): string => readFileSync(path.join(root, file), 'utf8');
const blobId = (cwd: string, content: string): string => execFileSync('git', ['hash-object', '--stdin'], { cwd, input: content, encoding: 'utf8', env }).trim();

function repo(): string {
  const root = path.join(temp(), 'repo');
  mkdirSync(root);
  git(root, 'init', '-q');
  write(root, '.gitignore', '*.log\n');
  write(root, 'tracked.txt', 'base\n');
  write(root, 'gone.txt', 'will be deleted\n');
  write(root, 'src/app.js', 'module.exports = 1;\n');
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'baseline');
  return root;
}

const target = (sourceRoot: string, nodeId = 'node-a', generation = 1, childId = 'child-a'): SnapshotTarget => ({ sourceRoot, sessionId: 'session-1', nodeId, generation, childId });

function userState(root: string) {
  git(root, 'status', '--porcelain=v2');
  const files = ['tracked.txt', 'untracked.txt', 'src/app.js'].filter(file => existsSync(path.join(root, file)));
  return {
    head: git(root, 'rev-parse', 'HEAD'), status: git(root, 'status', '--porcelain=v2', '--untracked-files=all'),
    index: createHash('sha256').update(readFileSync(path.join(root, '.git', 'index'))).digest('hex'),
    files: files.map(file => [file, read(root, file), statSync(path.join(root, file)).mtimeMs]),
  };
}

describe('execution snapshots', () => {
  it.skipIf(process.platform === 'win32')('preserves an internal instruction link through snapshot, child commit and regular-file integration', async () => {
    const root = repo();
    write(root, 'AGENTS.md', 'Project instructions\n');
    symlinkSync('AGENTS.md', path.join(root, 'CLAUDE.md'));
    git(root, 'add', 'AGENTS.md', 'CLAUDE.md'); git(root, 'commit', '-q', '-m', 'instructions');
    const head = git(root, 'rev-parse', 'HEAD');
    const { execution, manifest } = await takeExecutionSnapshot(target(root));
    try {
      expect(manifest.entries.find(entry => entry.path === 'CLAUDE.md')).toMatchObject({ mode: '120000', linkTarget: 'AGENTS.md', size: 9 });
      expect(git(root, 'show', `${execution.baseCommit}:CLAUDE.md`)).toBe('AGENTS.md');
      expect(lstatSync(path.join(execution.root, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
      expect(read(execution.root, 'CLAUDE.md')).toBe('Project instructions\n');
      write(execution.root, 'tracked.txt', 'delivered\n');
      const commit = hostCommitExecution(execution, { write: ['tracked.txt'] }, 'delivery');
      if (commit.status !== 'committed') throw new Error('expected committed delivery');
      const result = planIntegration({ root: execution.root, baseCommit: execution.baseCommit, commit: commit.commit, diff: git(execution.root, 'diff', '--binary', execution.baseCommit, commit.commit) }, root, 'link-fixture');
      if (result.status !== 'planned') throw new Error('expected integration plan');
      applyIntegrationPlan(result.plan);
      expect(read(root, 'tracked.txt')).toBe('delivered\n');
      expect(readlinkSync(path.join(root, 'CLAUDE.md'))).toBe('AGENTS.md');
      expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
      expect(workspaceVersion(root)).toBeTruthy();
    } finally { cleanupSessionExecutions(root, 'session-1'); }
  });

  it.skipIf(process.platform === 'win32')('detects a link retarget during capture and reports a missing link target explicitly', async () => {
    const root = repo();
    symlinkSync('tracked.txt', path.join(root, 'alias'));
    const first = workspaceVersion(root);
    const snapshot = await takeExecutionSnapshot(target(root), { beforeVerify: attempt => {
      if (attempt === 1) { unlinkSync(path.join(root, 'alias')); symlinkSync('gone.txt', path.join(root, 'alias')); }
    } });
    expect(snapshot.record.attempts).toBe(2);
    expect(workspaceVersion(root)).not.toBe(first);
    expect(readlinkSync(path.join(snapshot.execution.root, 'alias'))).toBe('gone.txt');
    cleanupSessionExecutions(root, 'session-1');
    unlinkSync(path.join(root, 'gone.txt'));
    await expect(takeExecutionSnapshot(target(root))).rejects.toMatchObject({ code: 'EXECUTION_FILE', message: expect.stringContaining('must exist') });
  });

  it('captures a dirty workspace into a ref and clone without changing HEAD, index or files', async () => {
    const root = repo();
    write(root, 'tracked.txt', 'modified\n'); write(root, 'untracked.txt', 'new\n'); write(root, 'debug.log', 'ignored\n');
    git(root, 'add', 'src/app.js'); unlinkSync(path.join(root, 'gone.txt'));
    const before = userState(root);
    const snapshot = await takeExecutionSnapshot(target(root));
    expect(userState(root)).toEqual(before);
    expect(existsSync(path.join(root, '.kodo', 'snapshots', 'node-a-1.index'))).toBe(false);
    const { execution, record } = snapshot;
    expect(record).toMatchObject({ ref: 'refs/kodo/snapshots/session-1/node-a-1', sourceHead: before.head.trim(), files: 4, excluded: 0, attempts: 1 });
    expect(git(root, 'rev-parse', record.ref).trim()).toBe(record.commit);
    expect(git(root, 'rev-parse', `${record.commit}^`).trim()).toBe(before.head.trim());
    expect(execution).toMatchObject({ kind: 'clone', baseCommit: record.commit });
    expect(git(execution.root, 'rev-parse', 'HEAD').trim()).toBe(record.commit);
    expect(git(execution.root, 'remote').trim()).toBe('');
    expect(read(execution.root, 'tracked.txt')).toBe('modified\n');
    expect(read(execution.root, 'untracked.txt')).toBe('new\n');
    expect(existsSync(path.join(execution.root, 'gone.txt'))).toBe(false);
    expect(existsSync(path.join(execution.root, 'debug.log'))).toBe(false);
    expect(git(execution.root, 'status', '--porcelain')).toBe('');
    expect(record.manifestDigest).toBe(workspaceVersion(root));
    expect(cleanupSessionExecutions(root, 'session-1').failures).toEqual([]);
  });

  it('never writes protected files to the object database or the snapshot tree', async () => {
    const root = repo();
    const secrets = { '.env': 'TOKEN=abc-env-secret\n', 'config/id_rsa': 'rsa-secret-material\n', 'certs/server.pem': 'pem-secret-material\n', '.env.local': 'LOCAL=1-secret\n' };
    for (const [file, content] of Object.entries(secrets)) write(root, file, content);
    const { record, execution } = await takeExecutionSnapshot(target(root));
    expect(record.excluded).toBe(4);
    const objects = git(root, 'cat-file', '--batch-all-objects', '--batch-check');
    for (const content of Object.values(secrets)) expect(objects).not.toContain(blobId(root, content));
    expect(git(root, 'ls-tree', '-r', '--name-only', record.commit).split('\n').filter(Boolean).sort()).toEqual(['.gitignore', 'gone.txt', 'src/app.js', 'tracked.txt']);
    for (const file of Object.keys(secrets)) expect(existsSync(path.join(execution.root, file))).toBe(false);
    cleanupSessionExecutions(root, 'session-1');
  });

  it('snapshots a repository without commits without a parent', async () => {
    const root = path.join(temp(), 'empty'); mkdirSync(root); git(root, 'init', '-q');
    write(root, 'first.txt', 'one\n');
    const { record, execution } = await takeExecutionSnapshot(target(root));
    expect(record.sourceHead).toBeNull();
    expect(git(root, 'cat-file', '-p', record.commit)).not.toContain('parent ');
    expect(read(execution.root, 'first.txt')).toBe('one\n');
    expect(cleanupSessionExecutions(root, 'session-1').failures).toEqual([]);
  });

  it('reuses an existing ref and checkout, and rebuilds a half-made checkout', async () => {
    const root = repo(); write(root, 'untracked.txt', 'new\n');
    const first = await takeExecutionSnapshot(target(root));
    expect(first.record.reused).toEqual({ ref: false, checkout: false });
    const second = await takeExecutionSnapshot(target(root));
    expect(second.record).toMatchObject({ commit: first.record.commit, reused: { ref: true, checkout: true } });
    rmSync(path.join(first.execution.root, '.git'), { recursive: true, force: true });
    const third = await takeExecutionSnapshot(target(root));
    expect(third.record.reused).toEqual({ ref: true, checkout: false });
    expect(git(third.execution.root, 'rev-parse', 'HEAD').trim()).toBe(first.record.commit);
    cleanupSessionExecutions(root, 'session-1');
  });

  it('retries when the workspace changes externally and fails after three attempts', async () => {
    const root = repo();
    let changes = 0;
    const once = await takeExecutionSnapshot(target(root), { beforeVerify: attempt => { if (attempt === 1) { changes++; write(root, 'tracked.txt', 'edited by an editor\n'); } } });
    expect(once.record.attempts).toBe(2); expect(changes).toBe(1);
    expect(read(once.execution.root, 'tracked.txt')).toBe('edited by an editor\n');
    await expect(takeExecutionSnapshot(target(root, 'node-b', 1, 'child-b'), { beforeVerify: attempt => write(root, 'tracked.txt', 'x'.repeat(attempt + 30)) }))
      .rejects.toThrow(expect.objectContaining({ code: 'EXECUTION_SNAPSHOT_CHANGED', message: expect.stringContaining('modified externally during the snapshot') }));
    expect(existsSync(path.join(path.dirname(root), '.kodo-executions', 'session-1', 'child-b'))).toBe(false);
    cleanupSessionExecutions(root, 'session-1');
  });
});

describe('host commit of a child checkout', () => {
  it('commits regular in-scope changes with host identity and lists ignored new files', async () => {
    const root = repo();
    const { execution } = await takeExecutionSnapshot(target(root));
    write(execution.root, 'src/app.js', 'module.exports = 2;\n'); write(execution.root, 'src/new.js', 'new\n'); write(execution.root, 'trace.log', 'noise\n');
    const result = hostCommitExecution(execution, { write: ['src'] }, 'deliver');
    expect(result).toMatchObject({ status: 'committed', baseCommit: execution.baseCommit, files: ['src/app.js', 'src/new.js'], ignored: ['trace.log'] });
    expect(git(execution.root, 'log', '-1', '--format=%an <%ae>').trim()).toBe('Kodo <kodo@localhost>');
    expect(hostCommitExecution(execution, undefined, 'again')).toMatchObject({ status: 'committed', files: ['src/app.js', 'src/new.js'] });
    cleanupSessionExecutions(root, 'session-1');
  });

  it('reports every violation without committing, and reports no changes', async () => {
    const root = repo();
    const { execution } = await takeExecutionSnapshot(target(root));
    expect(hostCommitExecution(execution, undefined, 'none')).toMatchObject({ status: 'unchanged', commit: execution.baseCommit, files: [] });
    write(execution.root, '.env', 'SECRET=1\n'); write(execution.root, 'tracked.txt', 'outside scope\n'); write(execution.root, 'src/app.js', 'ok\n');
    let started = false;
    const result = hostCommitExecution(execution, { write: ['src'] }, 'deliver', () => { started = true; });
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.violations.map(v => [v.path, v.code]).sort()).toEqual([['.env', 'PATH_DENIED'], ['tracked.txt', 'FILE_SCOPE']]);
    expect(started).toBe(false);
    expect(git(execution.root, 'rev-parse', 'HEAD').trim()).toBe(execution.baseCommit);
    cleanupSessionExecutions(root, 'session-1');
  });
});

describe('checkout retention', () => {
  it('releases one checkout with its ref and refuses unmanaged directories', async () => {
    const root = repo();
    const a = await takeExecutionSnapshot(target(root));
    const b = await takeExecutionSnapshot(target(root, 'node-b', 2, 'child-b'));
    expect(releaseExecutionCheckout(a.execution, a.record.ref)).toEqual({ removed: [a.execution.root, a.record.ref], failures: [] });
    expect(existsSync(a.execution.root)).toBe(false);
    expect(git(root, 'for-each-ref', '--format=%(refname)', 'refs/kodo/').trim()).toBe(snapshotRef('session-1', 'node-b', 2));
    const outside = temp();
    const refused = releaseExecutionCheckout({ root: outside, sourceRoot: root }, 'refs/heads/main');
    expect(refused.removed).toEqual([]);
    expect(refused.failures.map(failure => failure.code)).toEqual(['EXECUTION_ROOT', 'EXECUTION_REF']);
    expect(existsSync(outside)).toBe(true);
    expect(cleanupSessionExecutions(root, 'session-1').failures).toEqual([]);
    expect(existsSync(b.execution.root)).toBe(false);
    expect(existsSync(path.dirname(b.execution.root))).toBe(false);
    expect(git(root, 'for-each-ref', 'refs/kodo/').trim()).toBe('');
    expect(cleanupSessionExecutions(root, '../escape').failures[0]!.code).toBe('EXECUTION_ROOT');
  });
});
