import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';

test('comparison refuses incomplete or older frozen conditions before any model request and leaves evidence unchanged', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kodo-comparison-conditions-'));
  const script = path.resolve(import.meta.dirname, '../compare-harnesses.mjs');
  await mkdir(path.join(directory, 'source'));
  const env = { ...process.env, KODO_API_KEY: 'offline-placeholder', KODO_MODEL: 'offline-test', KODO_BASE_URL: 'http://127.0.0.1:1/v1' };
  try {
    for (const evaluationVersion of ['kernel-gap-fixes-v1', 'kernel-gap-fixes-v2']) {
      const manifest = JSON.stringify({ evaluationVersion, model: env.KODO_MODEL, upstream: env.KODO_BASE_URL, source: {}, budgets: { sharedToolTimeoutMs: 30000 } });
      const file = path.join(directory, 'manifest.json');
      await writeFile(file, manifest, 'utf8');
      const result = spawnSync(process.execPath, [script, '--root', directory], { env, windowsHide: true, encoding: 'utf8', timeout: 10_000 });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Frozen comparison conditions mismatch/);
      assert.doesNotMatch(result.stdout, /comparison.started|trial.started/);
      assert.equal(await readFile(file, 'utf8'), manifest);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
