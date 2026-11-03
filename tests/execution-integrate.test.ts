import { takeExecutionSnapshot } from '../src/runtime/execution-checkout.js';
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { applyIntegrationPlan, integrationStaging, planIntegration, reconcileIntegration } from '../src/runtime/execution-integrate.js';
import type { IntegrationPlan, IntegrationSource } from '../src/runtime/execution-integrate.js';
import { hostCommitExecution, workspaceVersion } from '../src/runtime/execution-snapshot.js';
import { cleanupSessionExecutions } from '../src/runtime/execution-retention.js';
import { temp } from './helpers.js';

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', windowsHide: true, env });
const write = (root: string, file: string, content: string): void => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), content); };
const read = (root: string, file: string): string => readFileSync(path.join(root, file), 'utf8');
const lines = (...values: string[]): string => values.map(value => `${value}\n`).join('');

/** Destination repo, child checkout from a snapshot, child edits committed by the host. */
async function delivery(edit: (child: string) => void, prepare: (root: string) => void = () => {}) {
  const root = path.join(temp(), 'repo'); mkdirSync(root);
  git(root, 'init', '-q');
  write(root, 'a.txt', lines('one', 'two', 'three', 'four', 'five', 'six'));
  write(root, 'b.txt', lines('bee'));
  write(root, 'old.txt', lines('remove me'));
  git(root, 'add', '.'); git(root, 'commit', '-q', '-m', 'baseline');
  prepare(root);
  const { execution } = await takeExecutionSnapshot({ sourceRoot: root, sessionId: 'session-1', nodeId: 'node', generation: 1, childId: 'child' });
  edit(execution.root);
  const committed = hostCommitExecution(execution, undefined, 'child delivery');
  if (committed.status === 'rejected') throw new Error('unexpected rejection');
  const diff = git(execution.root, 'diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', execution.baseCommit, committed.commit, '--');
  const source: IntegrationSource = { root: execution.root, baseCommit: execution.baseCommit, commit: committed.commit, diff };
  return { root: execution.sourceRoot, source, cleanup: () => cleanupSessionExecutions(root, 'session-1') };
}

const standard = (child: string): void => {
  write(child, 'a.txt', lines('ONE', 'two', 'three', 'four', 'five', 'six'));
  write(child, 'b.txt', lines('bee', 'bee two'));
  write(child, 'dir/new.txt', lines('created'));
  execFileSync('git', ['rm', '-q', 'old.txt'], { cwd: child, env });
};

function planned(root: string, source: IntegrationSource, callId = 'call-1'): IntegrationPlan {
  const result = planIntegration(source, root, callId);
  if (result.status !== 'planned') throw new Error(`expected a plan, got ${result.status}`);
  // Persisted as an artifact by L3; the round trip proves the plan is plain JSON.
  return JSON.parse(JSON.stringify(result.plan)) as IntegrationPlan;
}

function indexHash(root: string): string { return createHash('sha256').update(readFileSync(path.join(root, '.git', 'index'))).digest('hex'); }

describe('integration plans', () => {
  it('plans from actual pre-images, including parallel edits to other lines, and applies without touching the index', async () => {
    const { root, source, cleanup } = await delivery(standard);
    write(root, 'a.txt', lines('one', 'two', 'three', 'four', 'five', 'SIX by main'));
    git(root, 'status', '--porcelain');
    const index = indexHash(root); const status = git(root, 'status', '--porcelain=v2');
    const plan = planned(root, source);
    expect(read(root, 'a.txt')).toBe(lines('one', 'two', 'three', 'four', 'five', 'SIX by main'));
    expect(existsSync(integrationStaging(root, 'call-1'))).toBe(false);
    expect(plan.files.map(file => [file.path, file.pre.exists, file.post.exists])).toEqual([['a.txt', true, true], ['b.txt', true, true], ['dir/new.txt', false, true], ['old.txt', true, false]]);
    expect(Buffer.from(plan.files[0]!.post.content!, 'base64').toString()).toBe(lines('ONE', 'two', 'three', 'four', 'five', 'SIX by main'));
    expect(plan.files[2]!.post).toMatchObject({ mode: '100644' });
    let started = 0;
    const applied = applyIntegrationPlan(plan, () => { started++; });
    expect(started).toBe(1);
    expect(read(root, 'a.txt')).toBe(lines('ONE', 'two', 'three', 'four', 'five', 'SIX by main'));
    expect(read(root, 'dir/new.txt')).toBe(lines('created'));
    expect(existsSync(path.join(root, 'old.txt'))).toBe(false);
    expect(applied.version).toBe(workspaceVersion(root));
    expect(indexHash(root)).toBe(index);
    expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(root, 'status', '--porcelain=v2')).not.toBe(status);
    expect(reconcileIntegration(plan)).toMatchObject({ status: 'applied', completed: [] });
    cleanup();
  });

  it('reports a conflict and leaves the destination untouched', async () => {
    const { root, source, cleanup } = await delivery(standard);
    write(root, 'a.txt', lines('uno', 'two', 'three', 'four', 'five', 'six'));
    const before = ['a.txt', 'b.txt', 'old.txt'].map(file => read(root, file));
    const result = planIntegration(source, root, 'call-2');
    expect(result).toMatchObject({ status: 'conflict', files: expect.arrayContaining(['a.txt']) });
    expect(['a.txt', 'b.txt', 'old.txt'].map(file => read(root, file))).toEqual(before);
    expect(existsSync(path.join(root, 'dir'))).toBe(false);
    expect(existsSync(integrationStaging(root, 'call-2'))).toBe(false);
    cleanup();
  });

  it('conflicts when a file the child creates already exists, and returns empty for no changes', async () => {
    const created = await delivery(child => write(child, 'dir/new.txt', 'child\n'));
    write(created.root, 'dir/new.txt', 'main\n');
    expect(planIntegration(created.source, created.root, 'call-3').status).toBe('conflict');
    expect(read(created.root, 'dir/new.txt')).toBe('main\n');
    created.cleanup();
    const empty = await delivery(() => {});
    expect(planIntegration(empty.source, empty.root, 'call-4')).toEqual({ status: 'empty' });
    empty.cleanup();
  });

  it('refuses to apply a plan whose pre-images moved before start', async () => {
    const { root, source, cleanup } = await delivery(standard);
    const plan = planned(root, source);
    write(root, 'b.txt', 'changed after planning\n');
    let started = false;
    expect(() => applyIntegrationPlan(plan, () => { started = true; })).toThrow(expect.objectContaining({ code: 'EXECUTION_INTEGRATE_STALE' }));
    expect(started).toBe(false);
    expect(read(root, 'a.txt')).toBe(lines('one', 'two', 'three', 'four', 'five', 'six'));
    cleanup();
  });

  it('keeps an executable bit recorded by the delivery', async () => {
    const { root, source, cleanup } = await delivery(child => {
      write(child, 'run.sh', '#!/bin/sh\necho hi\n');
      if (process.platform !== 'win32') chmodSync(path.join(child, 'run.sh'), 0o755);
      execFileSync('git', ['add', '--chmod=+x', 'run.sh'], { cwd: child, env });
    });
    const plan = planned(root, source);
    expect(plan.files).toEqual([expect.objectContaining({ path: 'run.sh', pre: { exists: false }, post: expect.objectContaining({ exists: true, mode: '100755' }) })]);
    applyIntegrationPlan(plan);
    expect(read(root, 'run.sh')).toContain('echo hi');
    cleanup();
  });
});

describe('integration recovery', () => {
  it('after planning but before start, nothing in the destination changed', async () => {
    const { root, source, cleanup } = await delivery(standard);
    const before = workspaceVersion(root);
    planned(root, source);
    expect(workspaceVersion(root)).toBe(before);
    expect(existsSync(path.join(root, '.kodo', 'integrate', 'call-1'))).toBe(false);
    cleanup();
  });

  it('completes a partial apply idempotently, including creation and deletion', async () => {
    const { root, source, cleanup } = await delivery(standard);
    const plan = planned(root, source);
    // Simulated crash after `started`: only a.txt was written and old.txt deleted.
    write(root, 'a.txt', Buffer.from(plan.files[0]!.post.content!, 'base64').toString());
    rmSync(path.join(root, 'old.txt'));
    const first = reconcileIntegration(plan);
    expect(first).toMatchObject({ status: 'applied', completed: ['b.txt', 'dir/new.txt'] });
    expect(read(root, 'b.txt')).toBe(lines('bee', 'bee two'));
    expect(read(root, 'dir/new.txt')).toBe(lines('created'));
    expect(existsSync(path.join(root, 'old.txt'))).toBe(false);
    const again = reconcileIntegration(plan);
    expect(again).toMatchObject({ status: 'applied', completed: [] });
    if (first.status === 'applied' && again.status === 'applied') expect(again.version).toBe(first.version);
    cleanup();
  });

  it('classifies a third-state file as unknown and writes nothing', async () => {
    const { root, source, cleanup } = await delivery(standard);
    const plan = planned(root, source);
    write(root, 'a.txt', 'written by another process\n');
    const before = workspaceVersion(root);
    expect(reconcileIntegration(plan)).toEqual({ status: 'unknown', files: ['a.txt'] });
    expect(workspaceVersion(root)).toBe(before);
    expect(existsSync(path.join(root, 'dir', 'new.txt'))).toBe(false);
    expect(existsSync(path.join(root, 'old.txt'))).toBe(true);
    cleanup();
  });

  it('tracks existence: a planned new file created by someone else is unknown', async () => {
    const { root, source, cleanup } = await delivery(standard);
    const plan = planned(root, source);
    write(root, 'dir/new.txt', 'other content\n');
    expect(reconcileIntegration(plan)).toEqual({ status: 'unknown', files: ['dir/new.txt'] });
    expect(read(root, 'a.txt')).toBe(lines('one', 'two', 'three', 'four', 'five', 'six'));
    cleanup();
  });
});
