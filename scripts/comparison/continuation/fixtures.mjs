// Pre-registered fixtures for the minimal real-continuation check (§9B of
// docs/context-compaction-architecture-review.md).
//
// This module is deliberately dependency-free and side-effect free: it has no
// model, network or state-store access. The continuation runner imports the
// exported fixtures, seeds a fresh workspace from the asset tree and hashes the
// protected files. The dry-run provider uses `dryRunReadFiles` as its exact,
// ordered read plan so that the number of natural compactions is reproducible.
//
// Two tasks share the same mini project. Task A has a trimmed documentation tree
// and triggers one natural compaction while the agent reads the docs in order.
// Task B ships the same core docs plus six more, so reading them in order pushes
// the working input past workInputTokens twice, and one early-folded constraint
// (the frozen legacy page-size limit) has to survive both folds.
//
// Deliberately NOT part of the objective text (it lives in the docs so that the
// check exercises retention instead of prompt echoing):
//   MAX_PAGE_SIZE must remain 37 and the legacy exports must stay unchanged.

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registeredTask } from './registration.mjs';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const assetsRoot = path.join(moduleDirectory, 'assets');

const TASK_A_OBJECTIVE = [
  'Work in a small Node.js ESM project. Before changing anything, read the project documentation under docs/ first, in order, starting with docs/README.md; the docs describe the required pager behavior.',
  'The pagination library currently fails acceptance. Run `node verify.mjs` from the workspace root, then fix the source code until it exits with code 0. Re-run `node verify.mjs` after each change and confirm the real output instead of assuming the fix worked.',
  'Never modify verify.mjs, anything under docs/, or src/legacy.js: those files are protected and will be hashed after the run. Only edit source files (for example src/pager.mjs). Do not add dependencies and do not use the network.',
  'When acceptance passes, deliver a short summary of the defects you found, the changes you made, and the final verify result. Do not ask the user questions; work independently.',
].join(' ');

const TASK_B_OBJECTIVE = [
  'Work in a small Node.js ESM project. Before changing anything, read all of the project documentation under docs/ first, in the order presented, starting with docs/README.md; the docs describe the required pager behavior and the frozen legacy rules.',
  'The pagination library currently fails acceptance. Run `node verify.mjs` from the workspace root, then fix the source code until it exits with code 0. Re-run `node verify.mjs` after each change and confirm the real output instead of assuming the fix worked.',
  'Never modify verify.mjs, anything under docs/, or src/legacy.js: those files are protected and will be hashed after the run. Only edit source files (for example src/pager.mjs). Do not add dependencies and do not use the network.',
  'When acceptance passes, deliver a short summary of the defects you found, the changes you made, the final verify result, and which frozen legacy limit the pager now uses. Do not ask the user questions; work independently.',
].join(' ');

// Order matters. The first two documents are small and are read immediately, so
// the frozen-legacy constraint is inside the first compacted fold in both tasks.
const CORE_READ_ORDER = [
  'docs/README.md',
  'docs/legacy-contract.md',
  'docs/01-overview.md',
  'docs/02-requirements.md',
  'docs/03-api-contract.md',
  'docs/04-behavior.md',
  'docs/05-testing.md',
  'docs/06-operations.md',
  'docs/07-changelog.md',
];

const TASK_B_EXTRA_DOCS = [
  'docs/08-faq.md',
  'docs/09-architecture-decisions.md',
  'docs/10-observability.md',
  'docs/11-migration.md',
  'docs/12-security.md',
  'docs/13-performance.md',
];

const definitions = [
  {
    ...registeredTask('task-a'),
    objective: TASK_A_OBJECTIVE,
    assetName: 'task-a',
    dryRunReadFiles: [...CORE_READ_ORDER],
    verifyCommand: ['node', 'verify.mjs'],
    protected: ['verify.mjs', 'docs', 'src/legacy.js'],
  },
  {
    ...registeredTask('task-b'),
    objective: TASK_B_OBJECTIVE,
    assetName: 'task-b',
    dryRunReadFiles: [...CORE_READ_ORDER, ...TASK_B_EXTRA_DOCS],
    verifyCommand: ['node', 'verify.mjs'],
    protected: ['verify.mjs', 'docs', 'src/legacy.js'],
  },
];

/** Absolute path of `assets/<task>/workspace`, derived from this module URL. */
export const fixtures = definitions.map(({ assetName, ...fixture }) => ({
  ...fixture,
  assetsDir: path.resolve(assetsRoot, assetName, 'workspace'),
}));

function toPosix(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function listFilesRecursively(rootDirectory, relativePrefix = '') {
  const files = [];
  for (const entry of readdirSync(rootDirectory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = relativePrefix ? path.posix.join(relativePrefix, entry.name) : entry.name;
    const absolute = path.join(rootDirectory, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursively(absolute, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

/**
 * Copy the fixture's asset tree into `workspaceDir`, creating directories, and
 * expand every protected entry into the exact list of files whose hashes must be
 * unchanged after the run. Throws when the asset tree or a protected entry is
 * missing instead of silently producing an empty acceptance list.
 */
export function seedWorkspace(fixture, workspaceDir) {
  if (!fixture || typeof fixture !== 'object') throw new TypeError('seedWorkspace: fixture object is required');
  if (typeof fixture.assetsDir !== 'string' || fixture.assetsDir.length === 0) throw new TypeError('seedWorkspace: fixture.assetsDir must be a non-empty path');
  if (typeof workspaceDir !== 'string' || workspaceDir.length === 0) throw new TypeError('seedWorkspace: workspaceDir must be a non-empty path');
  if (!Array.isArray(fixture.protected) || fixture.protected.length === 0) throw new TypeError('seedWorkspace: fixture.protected must be a non-empty array');
  if (!existsSync(fixture.assetsDir)) throw new Error(`seedWorkspace: fixture assets directory does not exist: ${fixture.assetsDir}`);
  const destination = path.resolve(workspaceDir);
  const source = path.resolve(fixture.assetsDir);
  if (destination === source) throw new Error('seedWorkspace: workspaceDir must differ from fixture.assetsDir');
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true });

  const protectedFiles = [];
  for (const entry of fixture.protected) {
    if (typeof entry !== 'string' || entry.length === 0) throw new TypeError('seedWorkspace: every protected entry must be a non-empty string');
    const relative = toPosix(path.posix.normalize(entry.replace(/\\/g, '/')));
    if (relative.startsWith('../') || relative === '..' || path.posix.isAbsolute(relative)) {
      throw new Error(`seedWorkspace: protected entry must stay inside the workspace: ${entry}`);
    }
    const absolute = path.resolve(destination, relative);
    if (!absolute.startsWith(destination + path.sep)) throw new Error(`seedWorkspace: protected entry escapes the workspace: ${entry}`);
    if (!existsSync(absolute)) throw new Error(`seedWorkspace: protected entry is missing from the seeded workspace: ${entry}`);
    const stats = statSync(absolute);
    if (stats.isDirectory()) protectedFiles.push(...listFilesRecursively(absolute, relative));
    else if (stats.isFile()) protectedFiles.push(relative);
    else throw new Error(`seedWorkspace: protected entry is not a regular file or directory: ${entry}`);
  }
  protectedFiles.sort();
  return { protectedFiles };
}

/** Relative path of the index-th document the dry-run provider should read. */
export function dryRunFileName(fixture, index) {
  if (!fixture || typeof fixture !== 'object') throw new TypeError('dryRunFileName: fixture object is required');
  if (!Array.isArray(fixture.dryRunReadFiles)) throw new TypeError('dryRunFileName: fixture.dryRunReadFiles must be an array');
  if (!Number.isInteger(index)) throw new TypeError('dryRunFileName: index must be an integer');
  if (index < 0 || index >= fixture.dryRunReadFiles.length) {
    throw new RangeError(`dryRunFileName: index ${index} is outside 0..${fixture.dryRunReadFiles.length - 1} for ${fixture.id ?? 'fixture'}`);
  }
  return fixture.dryRunReadFiles[index];
}
