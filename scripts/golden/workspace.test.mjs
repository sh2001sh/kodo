import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ensureDeliverableDir } from './workspace.mjs';

const tempWorkspace = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kodo-golden-workspace-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

test('ensureDeliverableDir creates a missing deliverable directory in the seeded workspace', () => {
  const { root, cleanup } = tempWorkspace();
  try {
    assert.deepEqual(readdirSync(root), []);
    const created = ensureDeliverableDir(root, 'deliverables');
    assert.equal(created, path.join(root, 'deliverables'));
    assert.equal(statSync(created).isDirectory(), true);
    // Nested deliverable directories are created recursively.
    const nested = ensureDeliverableDir(root, 'deliverables/charts');
    assert.equal(statSync(nested).isDirectory(), true);
    assert.deepEqual(readdirSync(root), ['deliverables']);
  } finally { cleanup(); }
});

test('ensureDeliverableDir leaves an existing directory and its files untouched', () => {
  const { root, cleanup } = tempWorkspace();
  try {
    const directory = path.join(root, 'deliverables');
    mkdirSync(directory);
    writeFileSync(path.join(directory, 'existing.md'), 'keep me');
    assert.equal(ensureDeliverableDir(root, 'deliverables'), directory);
    assert.deepEqual(readdirSync(directory), ['existing.md']);
    // Idempotent.
    assert.equal(ensureDeliverableDir(root, 'deliverables'), directory);
  } finally { cleanup(); }
});

test('ensureDeliverableDir no-ops for the workspace root and rejects escaping paths', () => {
  const { root, cleanup } = tempWorkspace();
  try {
    assert.equal(ensureDeliverableDir(root, '.'), null);
    assert.deepEqual(readdirSync(root), []);
    assert.throws(() => ensureDeliverableDir(root, '../outside'), /stay inside the workspace/u);
    assert.throws(() => ensureDeliverableDir(root, '/absolute'), /stay inside the workspace/u);
    assert.throws(() => ensureDeliverableDir(root, 'C:/absolute'), /stay inside the workspace/u);
  } finally { cleanup(); }
});
