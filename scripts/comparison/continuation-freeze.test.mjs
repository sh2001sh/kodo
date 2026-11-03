import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBuildManifest, BUILD_MANIFEST_PATH } from '../write-build-manifest.mjs';
import { assertBuildMatchesSource, captureFreeze, compareFreeze } from './continuation/freeze.mjs';

const repository = path.resolve(import.meta.dirname, '..', '..');

test('capturing unchanged experiment inputs is stable', () => {
  const before = captureFreeze(repository);
  const after = captureFreeze(repository);
  assert.deepEqual(compareFreeze(before, after), { ok: true, changes: [] });
  assert.equal(before.groups.source.digest, after.groups.source.digest);
  assert.equal(before.groups.fixture.digest, after.groups.fixture.digest);
});

test('build check rejects source changes made after the manifest was written', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'kodo-build-freeze-'));
  try {
    await mkdir(path.join(temporary, 'src'), { recursive: true });
    await mkdir(path.join(temporary, 'dist'), { recursive: true });
    await writeFile(path.join(temporary, 'package.json'), '{}\n', 'utf8');
    await writeFile(path.join(temporary, 'tsconfig.json'), '{}\n', 'utf8');
    await writeFile(path.join(temporary, 'tsconfig.build.json'), '{}\n', 'utf8');
    await writeFile(path.join(temporary, 'src', 'index.ts'), 'export const value = 1;\n', 'utf8');
    await writeFile(path.join(temporary, 'dist', 'index.js'), 'export const value = 1;\n', 'utf8');
    const manifest = createBuildManifest(temporary);
    await writeFile(path.join(temporary, BUILD_MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    assert.equal(assertBuildMatchesSource(temporary).ok, true);
    await writeFile(path.join(temporary, 'src', 'index.ts'), 'export const value = 2;\n', 'utf8');
    assert.throws(() => assertBuildMatchesSource(temporary), /source\/dist build mismatch: source digest changed/);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

