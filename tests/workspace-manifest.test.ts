import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256, workspaceManifest, indexModes } from '../src/runtime/workspace-manifest.js';
import { temp } from './helpers.js';

const git = (root: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: root, encoding: 'utf8', windowsHide: true });

function repo(): string {
  const root = temp();
  git(root, 'init', '-b', 'main');
  writeFileSync(path.join(root, 'README.md'), 'manifest fixture\n');
  writeFileSync(path.join(root, '.env'), 'SECRET=1\n');
  mkdirSync(path.join(root, '.kodo'), { recursive: true });
  writeFileSync(path.join(root, '.kodo', 'runtime.json'), '{"private":true}\n');
  git(root, 'add', 'README.md', '.env');
  git(root, 'commit', '-m', 'baseline');
  return root;
}

describe('workspace manifest hashing', () => {
  it('is a pure function of eligible content and excludes protected paths', () => {
    const root = repo();
    const first = workspaceManifest(root);
    const second = workspaceManifest(root);
    expect(second.digest).toBe(first.digest);
    expect(first.entries.map(entry => entry.path)).toEqual(['README.md']);
    expect(first.excluded).toBeGreaterThanOrEqual(2);
    expect(sha256(Buffer.from('manifest fixture\n'))).toBe(first.entries[0]!.hash);
    expect(first.entries[0]!.size).toBe('manifest fixture\n'.length);
  });

  it('changes the digest when eligible content changes and ignores excluded content', () => {
    const root = repo();
    const before = workspaceManifest(root).digest;
    writeFileSync(path.join(root, 'README.md'), 'changed fixture\n');
    const changed = workspaceManifest(root);
    expect(changed.digest).not.toBe(before);
    writeFileSync(path.join(root, '.kodo', 'runtime.json'), '{"private":false}\n');
    writeFileSync(path.join(root, '.env'), 'SECRET=2\n');
    expect(workspaceManifest(root).digest).toBe(changed.digest);
  });

  it('includes unignored untracked regular files and tracks their content hash', () => {
    const root = repo();
    writeFileSync(path.join(root, 'new.txt'), 'untracked\n');
    const manifest = workspaceManifest(root);
    expect(manifest.entries.map(entry => entry.path)).toContain('new.txt');
    expect(manifest.entries.find(entry => entry.path === 'new.txt')!.hash).toBe(sha256(Buffer.from('untracked\n')));
    writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
    writeFileSync(path.join(root, 'ignored.txt'), 'ignored\n');
    expect(workspaceManifest(root).entries.map(entry => entry.path)).not.toContain('ignored.txt');
  });

  it('records index file modes so Windows matches the tracked executable bit', () => {
    const root = repo();
    git(root, 'update-index', '--chmod=+x', 'README.md');
    expect(indexModes(root).get('README.md')).toBe('100755');
    expect(workspaceManifest(root).entries.find(entry => entry.path === 'README.md')!.mode).toBe('100755');
    chmodSync(path.join(root, 'README.md'), 0o644);
  });

  it.skipIf(process.platform === 'win32')('rejects a symlink that resolves outside the workspace', () => {
    const root = repo();
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.txt`);
    writeFileSync(outside, 'outside\n');
    symlinkSync(outside, path.join(root, 'escape.txt'));
    expect(() => workspaceManifest(root)).toThrow(/snapshot link/);
  });
});
