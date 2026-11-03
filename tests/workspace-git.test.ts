import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { workspaceGit } from '../src/runtime/workspace-git.js';
import type { WorkspaceGitArgs } from '../src/runtime/workspace-git.js';
import { fixture } from './helpers.js';

const git = (root: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
function setup() {
  const f = fixture();
  git(f.root, 'init', '-b', 'main');
  writeFileSync(path.join(f.root, 'value.txt'), 'baseline\n');
  writeFileSync(path.join(f.root, 'other.txt'), 'original\n');
  git(f.root, 'add', 'value.txt', 'other.txt');
  git(f.root, 'commit', '-m', 'baseline');
  const head = git(f.root, 'rev-parse', 'HEAD').trim();
  const started = vi.fn();
  const invoke = (args: WorkspaceGitArgs) => workspaceGit(f.app.store, f.app.store.run(f.runId), args, started) as Record<string, unknown>;
  return { ...f, head, started, invoke };
}

describe('controlled original-workspace Git delivery', () => {
  it('creates a real original-repository branch and commits explicit files while preserving unrelated staged and unstaged edits', () => {
    const { root, head, invoke, started } = setup();
    writeFileSync(path.join(root, 'value.txt'), 'delivered\n');
    writeFileSync(path.join(root, 'other.txt'), 'user staged\n');
    git(root, 'add', 'other.txt');
    writeFileSync(path.join(root, 'other.txt'), 'user unstaged\n');
    writeFileSync(path.join(root, 'unrelated.txt'), 'private user draft\n');
    expect(invoke({ action: 'branch', name: 'feature/delivery', expectedHead: head })).toMatchObject({ branch: 'feature/delivery', head });
    const result = invoke({ action: 'commit', files: ['value.txt'], message: 'Deliver requested change', expectedHead: head });
    expect(result.commit).not.toBe(head);
    expect(git(root, 'branch', '--show-current').trim()).toBe('feature/delivery');
    expect(git(root, 'rev-parse', 'main').trim()).toBe(head);
    expect(git(root, 'show', 'HEAD:value.txt')).toBe('delivered\n');
    expect(git(root, 'show', 'HEAD:other.txt')).toBe('original\n');
    expect(git(root, 'show', ':other.txt')).toBe('user staged\n');
    expect(readFileSync(path.join(root, 'other.txt'), 'utf8')).toBe('user unstaged\n');
    expect(git(root, 'diff', '--cached', '--name-only').trim()).toBe('other.txt');
    expect(readFileSync(path.join(root, 'unrelated.txt'), 'utf8')).toBe('private user draft\n');
    expect(started).toHaveBeenCalled();
  });

  it('handles explicit additions and deletions and previews tracked changes without mutating HEAD', () => {
    const { root, head, invoke, started } = setup();
    rmSync(path.join(root, 'value.txt'));
    writeFileSync(path.join(root, 'new (file).txt'), 'new data\n');
    const preview = invoke({ action: 'diff', files: ['value.txt', 'new (file).txt'] });
    expect(preview.diff).toContain('deleted file');
    expect(preview.untracked).toEqual(['new (file).txt']);
    expect(started).not.toHaveBeenCalled();
    invoke({ action: 'commit', files: ['value.txt', 'new (file).txt'], message: 'Replace file', expectedHead: head });
    expect(git(root, 'ls-tree', '--name-only', 'HEAD')).toContain('new (file).txt');
    expect(git(root, 'ls-tree', '--name-only', 'HEAD')).not.toContain('value.txt');
    expect(git(root, 'diff', '--cached', '--name-only').trim()).toBe('');
  });

  it('rejects stale mutations, existing branches and a busy index before starting effects', () => {
    const { root, head, invoke, started } = setup();
    writeFileSync(path.join(root, 'value.txt'), 'changed\n');
    expect(() => invoke({ action: 'branch', name: 'other', expectedHead: 'incorrect' })).toThrow('expectedHead');
    expect(() => invoke({ action: 'branch', name: 'main', expectedHead: head })).toThrow('already exists');
    writeFileSync(path.join(root, '.git', 'index.lock'), 'user-owned lock');
    expect(() => invoke({ action: 'commit', files: ['value.txt'], message: 'change', expectedHead: head })).toThrow('index is busy');
    expect(readFileSync(path.join(root, '.git', 'index.lock'), 'utf8')).toBe('user-owned lock');
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(started).not.toHaveBeenCalled();
  });

  it('requires main ownership and both session and run permissions', () => {
    const { app, runId, invoke } = setup();
    app.store.updateRun(runId, { parentId: 'parent' });
    expect(() => invoke({ action: 'status' })).toThrow('main run');
    app.store.updateRun(runId, { parentId: undefined, permissions: ['read'] });
    expect(() => invoke({ action: 'branch', name: 'other' })).toThrow('write permission');
    expect(invoke({ action: 'status' })).toHaveProperty('head');
  });

  it('respects file scope and excludes protected and runtime files from delivery', () => {
    const { app, root, runId, head, invoke, started } = setup();
    writeFileSync(path.join(root, '.env'), 'placeholder');
    writeFileSync(path.join(root, 'value.txt'), 'changed\n');
    writeFileSync(path.join(root, 'other.txt'), 'changed\n');
    app.store.updateRun(runId, { scope: { read: ['value.txt'], write: ['value.txt'] } });
    expect(invoke({ action: 'status' }).files).toEqual(['value.txt']);
    expect(() => invoke({ action: 'commit', files: ['other.txt'], message: 'change', expectedHead: head })).toThrow('outside the readable scope');
    expect(() => invoke({ action: 'diff', files: ['.env'] })).toThrow('protected');
    expect(() => invoke({ action: 'diff', files: ['.state/kodo.sqlite'] })).toThrow('protected');
    expect(() => invoke({ action: 'branch', name: 'other', expectedHead: head })).toThrow('scope');
    expect(started).not.toHaveBeenCalled();
  });

  it('rejects directories and requires explicit changed files instead of staging all work', () => {
    const { head, invoke, started } = setup();
    expect(() => invoke({ action: 'commit', files: ['.'], message: 'all', expectedHead: head })).toThrow('relative files');
    expect(() => invoke({ action: 'commit', files: ['value.txt'], message: 'unchanged', expectedHead: head })).toThrow('changed file');
    expect(() => invoke({ action: 'commit', message: 'all', expectedHead: head })).toThrow('explicit');
    expect(started).not.toHaveBeenCalled();
  });
});
