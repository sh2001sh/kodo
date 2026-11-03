import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { contentManifest, verifyBuildManifest } from '../../write-build-manifest.mjs';

const toPosix = value => value.split(path.sep).join('/');

function walk(repository, relative) {
  const absolute = path.join(repository, relative);
  if (!existsSync(absolute)) return [];
  const files = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const next = toPosix(path.posix.join(relative, entry.name));
    if (entry.isDirectory()) files.push(...walk(repository, next));
    else if (entry.isFile()) files.push(next);
  }
  return files;
}

const git = (repository, args) => {
  const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
};

export function freezeGroups(repository) {
  const fixtureFiles = walk(repository, 'scripts/comparison/continuation/assets');
  return {
    source: walk(repository, 'src').filter(file => file.endsWith('.ts')),
    dist: walk(repository, 'dist').filter(file => file !== 'dist/.kodo-build-manifest.json' && /\.(?:js|d\.ts|map)$/.test(file)),
    runner: [
      'scripts/comparison/compaction-continuation.mjs',
      'scripts/comparison/continuation-audit.mjs',
      'scripts/comparison/relay.mjs',
      'scripts/comparison/continuation/freeze.mjs',
    ],
    fixture: ['scripts/comparison/continuation/fixtures.mjs', ...fixtureFiles],
    protocol: [
      'scripts/comparison/continuation/README.md',
      'scripts/comparison/continuation/registration.mjs',
      'scripts/comparison/continuation/outcomes.mjs',
    ],
    lockfile: ['package-lock.json'],
  };
}

export function captureFreeze(repository) {
  const groups = Object.fromEntries(Object.entries(freezeGroups(repository)).map(([name, files]) => [name, contentManifest(repository, files)]));
  const dirtyText = git(repository, ['status', '--short']);
  return {
    capturedAt: new Date().toISOString(),
    git: { commit: git(repository, ['rev-parse', 'HEAD']), dirty: dirtyText === null ? null : dirtyText.length > 0, statusDigest: dirtyText === null ? null : contentManifestFromText(dirtyText) },
    groups,
  };
}

function contentManifestFromText(text) {
  // The detailed dirty paths can leak unrelated workspace names. Group hashes
  // already identify experiment inputs; only expose whether the tree is dirty.
  return createHash('sha256').update(text).digest('hex');
}

export function compareFreeze(before, after) {
  const changes = [];
  for (const [name, group] of Object.entries(before.groups)) {
    if (after.groups[name]?.digest !== group.digest) changes.push({ group: name, before: group.digest, after: after.groups[name]?.digest ?? null });
  }
  return { ok: changes.length === 0, changes };
}

export function assertBuildMatchesSource(repository) {
  const check = verifyBuildManifest(repository);
  if (!check.ok) throw new Error(`source/dist build mismatch: ${check.problems.join('; ')}`);
  return check;
}
