import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { captureExecutionEvidence, executionArchiveCommand } from './execution-evidence.mjs';

test('archive copy targets all host clones outside /app, preserving Git and unintegrated files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'execution-archive-'));
  try {
    const commands = [];
    const archive = Buffer.from('isolated mocked binary archive\0');
    const result = await captureExecutionEvidence({ container: 'trial-fixture', directory, command: async (program, args, options) => {
      commands.push([program, ...args]);
      if (program === 'docker') { assert.equal(options.raw, true); return archive; }
      return ['completed-child', 'failed-child', 'cancelled-child'].flatMap(child => [
        `.kodo-executions/session/${child}/.git/HEAD`, `.kodo-executions/session/${child}/CLAUDE.md`,
      ]).join('\n');
    } });
    assert.deepEqual(commands, [['docker', 'cp', 'trial-fixture:/.kodo-executions', '-'], ['tar', '-tf', path.join(directory, 'executions.tar')]]);
    assert.equal(result.status, 'captured');
    assert.equal(result.clones.length, 3); assert.ok(result.clones.every(clone => clone.gitDirectory));
    assert.deepEqual(await readFile(path.join(directory, 'executions.tar')), archive);
    assert.equal(result.bytes, archive.length);
    assert.match(result.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(JSON.parse(await readFile(path.join(directory, 'process/execution-archive.json'), 'utf8')).status, 'captured');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an invalid tar stream remains a recording failure even after the copy succeeds', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'execution-archive-'));
  try {
    const result = await captureExecutionEvidence({ container: 'trial-fixture', directory, command: async program => {
      if (program === 'docker') return Buffer.from('broken archive');
      throw new Error('tar: damaged archive');
    } });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /damaged archive/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('only explicit missing clone directory is normal; daemon/copy failures remain errors', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'execution-archive-'));
  try {
    const missing = await captureExecutionEvidence({ container: 'trial-fixture', directory, command: async () => {
      throw new Error('Error response from daemon: Could not find the file /.kodo-executions in container trial-fixture');
    } });
    assert.equal(missing.status, 'absent');
    for (const message of ['No such container: trial-fixture', 'permission denied', 'copy timed out', 'No such file or directory']) {
      const result = await captureExecutionEvidence({ container: 'trial-fixture', directory, command: async () => { throw new Error(message); } });
      assert.equal(result.status, 'failed'); assert.equal(result.error, message);
    }
    assert.throws(() => executionArchiveCommand('../other', directory), /container identity/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
