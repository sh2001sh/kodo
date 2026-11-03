import { storageTestConnection } from '../src/storage/test-access.js';
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { Store } from '../src/storage/index.js';
import { CaseRunStore, caseDigest, compareCaseRuns, freezeCase, runCase } from '../src/cases/index.js';
import type { CaseDefinition, CaseRun, RunCaseOptions } from '../src/cases/index.js';

const cleanup: string[] = [];
const stores: Store[] = [];
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const directory of cleanup.splice(0)) await rm(directory, { force: true, recursive: true }); });
async function directory(): Promise<string> { const result = await mkdtemp(path.join(os.tmpdir(), 'kodo-cases-')); cleanup.push(result); return result; }
const definition: CaseDefinition = { schema_version: 1, id: 'example/json', version: '1.0.0', name: 'JSON output', objective: 'Return the frozen input answer as JSON.', inputs: { files: [], data: { answer: 42 } }, assertions: [{ type: 'json', source: 'output', pointer: '/answer', equals: 42 }] };
async function setup(): Promise<RunCaseOptions> {
  const storage = new Store(await directory()); stores.push(storage);
  return { store: new CaseRunStore(storage), definition, target: { id: 'example/agent', version: '1.0.0', digest: caseDigest('package'), cardDigest: caseDigest('card') }, workspace: await directory(), binding: { model: 'test', baseURL: 'http://localhost/v1', apiKeyEnv: 'UNUSED', limits: { context: 32000, output: 4096 } }, permissions: ['read', 'write'], hostPolicyDigest: caseDigest('test host'), execute: async () => ({ status: 'completed', output: '{"answer":42}' }) };
}
async function rerun(options: RunCaseOptions, overrides: Partial<RunCaseOptions> = {}): Promise<CaseRun> { return await runCase({ ...options, workspace: await directory(), ...overrides }); }

describe('frozen case format', () => {
  it('freezes detached input data and hashes object keys canonically', () => {
    const input = structuredClone(definition);
    const frozen = freezeCase(input); input.inputs.data = { answer: 0 };
    expect(frozen.definition.inputs.data).toEqual({ answer: 42 });
    expect(Object.isFrozen(frozen.definition.inputs)).toBe(true);
    expect(caseDigest({ a: 1, b: 2 })).toBe(caseDigest({ b: 2, a: 1 }));
    expect(() => freezeCase({ ...definition, permissions: ['exec'] })).toThrow('invalid case');
    expect(() => freezeCase({ ...definition, assertions: [] })).toThrow('invalid case');
  });
  it.each(['../escape', '/outside', 'C:/outside', 'file\\child', 'CON', 'test/../escape', 'file.'])('rejects nonportable or escaping fixture path %s', value => {
    expect(() => freezeCase({ ...definition, inputs: { files: [{ path: value, content: 'x' }] } })).toThrow('relative file');
  });
  it('rejects repeated case version with changed assertions', async () => {
    const options = await setup(); await runCase(options);
    await expect(rerun(options, { definition: { ...definition, assertions: [{ type: 'output', equals: 'changed' }] } })).rejects.toThrow('immutable');
  });
});

describe('case execution and durable evidence', () => {
  it('executes a real Application model run and persists model/environment evidence without credential values', async () => {
    const options = await setup();
    const app = new Application(await directory(), { complete: async () => ({ message: { role: 'assistant', content: '{"answer":42}' }, finishReason: 'stop' }) });
    try {
      const result = await runCase({ ...options, execute: async input => {
        expect(input.data).toEqual({ answer: 42 });
        const run = app.createRun({ workspace: input.workspace, objective: input.objective, binding: options.binding, permissions: input.permissions });
        const completed = await app.run(run.id);
        expect(completed.status).toBe('completed');
        return { runId: run.id, status: completed.status, output: app.store.readBlob<{ text: string }>(completed.resultRef!).text };
      } });
      expect(result.error).toBeUndefined();
      expect(result).toMatchObject({ status: 'passed', execution: { status: 'completed', runId: expect.any(String) }, assertions: [{ index: 0, passed: true }] });
      expect(result.conditions.environment.platform).toBe(process.platform);
      expect(JSON.stringify(result.conditions)).not.toContain('apiKeyEnv');
      expect(options.store.get(result.id)).toEqual(result);
    } finally { await app.shutdown(); }
  });
  it('checks actual file bytes, file absence and RFC 6901 pointers, rather than report text', async () => {
    const options = await setup();
    const contents = '{"a/b":{"~key":7}}';
    const result = await runCase({ ...options, definition: { ...definition, inputs: { files: [{ path: 'input.json', content: contents }] }, assertions: [
      { type: 'file', path: 'input.json', equals: contents }, { type: 'json', source: 'file', path: 'input.json', pointer: '/a~1b/~0key', equals: 7 },
      { type: 'file', path: 'missing.txt', exists: false },
    ] }, execute: async input => { expect(await readFile(path.join(input.workspace, 'input.json'), 'utf8')).toBe(contents); return { status: 'completed', output: 'all good' }; } });
    expect(result.status).toBe('passed');
    const failed = await rerun(options, { definition: { ...definition, version: '1.0.1', assertions: [{ type: 'file', path: 'not-produced.txt', equals: 'proof' }] }, execute: async () => ({ status: 'completed', output: 'I produced the required file, all tests pass' }) });
    expect(failed.status).toBe('failed'); expect(failed.assertions[0]?.passed).toBe(false);
  });
  it('retains failed execution, invalid JSON and absent pointers as failed evidence', async () => {
    const options = await setup();
    const failed = await runCase({ ...options, execute: async () => ({ status: 'failed', output: '{"answer":42}' }) });
    expect(failed.status).toBe('failed'); expect(failed.error).toContain('did not complete');
    const malformed = await rerun(options, { execute: async () => ({ status: 'completed', output: 'not JSON' }) });
    expect(malformed.assertions[0]).toMatchObject({ passed: false, detail: 'SyntaxError' });
    const missing = await rerun(options, { execute: async () => ({ status: 'completed', output: '{}' }) });
    expect(missing.assertions[0]?.detail).toContain('pointer does not exist');
    expect(options.store.list().items).toHaveLength(3);
  });
  it('requires an empty workspace, host fixture authorization and read scope', async () => {
    const options = await setup();
    await writeFile(path.join(options.workspace, 'existing'), 'user data');
    const dirty = await runCase(options); expect(dirty.error).toContain('must be empty');
    const fixture = { ...definition, version: '2.0.0', inputs: { files: [{ path: 'input.txt', content: 'secret' }] } };
    const denied = await rerun(options, { definition: fixture, permissions: ['read'] });
    expect(denied.error).toContain('host write permission');
    const scoped = await rerun(options, { definition: { ...fixture, version: '3.0.0', assertions: [{ type: 'file', path: 'input.txt', equals: 'secret' }] }, scope: { read: ['other'], write: ['.'] } });
    expect(scoped.assertions[0]?.detail).toContain('outside this run'); expect(scoped.status).toBe('failed');
  });
  it('rejects assertion symlinks outside the workspace', async () => {
    const options = await setup(); const outside = await directory();
    await writeFile(path.join(outside, 'secret'), 'private');
    const result = await runCase({ ...options, definition: { ...definition, assertions: [{ type: 'file', path: 'link/secret', equals: 'private' }] }, execute: async input => { await symlink(outside, path.join(input.workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); return { status: 'completed', output: '' }; } });
    expect(result.status).toBe('failed'); expect(result.assertions[0]?.detail).toContain('outside this run');
  });
  it.runIf(process.platform !== 'win32')('rejects a FIFO assertion without blocking its open or requiring a writer', async () => {
    const options = await setup();
    const result = await runCase({ ...options, definition: { ...definition, timeoutMs: 1000, assertions: [{ type: 'json', source: 'file', path: 'input.pipe', pointer: '', equals: {} }] }, execute: async input => { execFileSync('mkfifo', [path.join(input.workspace, 'input.pipe')], { timeout: 1000 }); return { status: 'completed', output: '' }; } });
    expect(result.status).toBe('failed');
    expect(result.error).toBeUndefined();
    expect(result.assertions[0]?.detail).toContain('regular file');
  });
  it('times out unresponsive execution and retains the failure', async () => {
    const options = await setup();
    const result = await runCase({ ...options, definition: { ...definition, timeoutMs: 10 }, execute: async () => await new Promise(() => {}) });
    expect(result.status).toBe('failed'); expect(result.error).toContain('TimeoutError'); expect(options.store.get(result.id).status).toBe('failed');
  });
  it('refuses a returned run identity that differs from the durable execution link', async () => {
    const options = await setup();
    const result = await runCase({ ...options, execute: async input => { input.recordExecution?.('original-run'); return { status: 'completed', output: '{"answer":42}', runId: 'different-run' }; } });
    expect(result.status).toBe('failed'); expect(result.error).toContain('differs from the run identity');
    expect(options.store.get(result.id).execution?.runId).toBe('original-run');
  });
  it('rejects oversized file/output assertion evidence', async () => {
    const options = await setup();
    const huge = await runCase({ ...options, execute: async () => ({ status: 'completed', output: 'x'.repeat(1_000_001) }) });
    expect(huge.error).toContain('exceeds 1 MB');
    const result = await rerun(options, { definition: { ...definition, version: '2.0.0', assertions: [{ type: 'file', path: 'huge.txt', equals: 'x' }] }, execute: async input => { await writeFile(path.join(input.workspace, 'huge.txt'), 'x'.repeat(1_000_001)); return { status: 'completed', output: '' }; } });
    expect(result.assertions[0]?.detail).toContain('at most 1 MB');
  });
  it('case command names do not grant capabilities or construct arbitrary executable arguments', async () => {
    const options = await setup();
    const result = await runCase({ ...options, definition: { ...definition, assertions: [{ type: 'command', command: 'test', exitCode: 0 }] }, execute: async () => ({ status: 'completed', output: '' }) });
    expect(result.status).toBe('failed'); expect(result.assertions[0]?.detail).toContain('trusted host command');
    await expect(rerun(options, { commands: { test: { program: 'node', args: [] } } })).rejects.toThrow('absolute executable');
    expect(() => freezeCase({ ...definition, assertions: [{ type: 'command', command: 'test', args: ['--evil'], exitCode: 0 }] })).toThrow('invalid case');
  });
  it('executes an explicitly trusted command in the OS sandbox and checks its real exit/output', async () => {
    const options = await setup();
    const result = await runCase({ ...options, permissions: ['read', 'exec'], definition: { ...definition, assertions: [{ type: 'command', command: 'check', exitCode: 0, stdout: 'checked' }] }, commands: { check: { program: process.execPath, args: ['-e', 'process.stdout.write("checked")'] } } });
    expect(result.assertions).toMatchObject([{ passed: true }]); expect(result.status).toBe('passed');
    const failed = await rerun(options, { permissions: ['read', 'exec'], definition: { ...definition, version: '2.0.0', assertions: [{ type: 'command', command: 'check', exitCode: 0 }] }, commands: { check: { program: process.execPath, args: ['-e', 'process.exit(7)'] } } });
    expect(failed.status).toBe('failed'); expect(failed.assertions[0]?.passed).toBe(false);
  }, 30000);
  it('pages results and detects database evidence tampering', async () => {
    const options = await setup(); const first = await runCase(options); await rerun(options);
    const page = options.store.list({ limit: 1 }); expect(page.items).toHaveLength(1); expect(page.next).not.toBeNull();
    expect(options.store.list({ limit: 1, after: page.next! }).items).toHaveLength(1);
    expect(() => options.store.list({ limit: 1001 })).toThrow('limit');
    const altered = { ...first, target: { ...first.target, digest: caseDigest('forged') } };
    storageTestConnection(stores.at(-1)!).prepare('UPDATE case_runs SET data=? WHERE id=?').run(JSON.stringify(altered), first.id);
    expect(() => options.store.get(first.id)).toThrow('digest does not match');
  });
  it('preserves evidence across restart and marks an unfinished run interrupted explicitly', async () => {
    const options = await setup(); const result = await runCase(options);
    const running = { ...result, id: 'unfinished', status: 'running' as const, assertions: [] }; delete running.completedAt; delete running.execution;
    options.store.start(running);
    options.store.attachExecution(running.id, 'unfinished-model-run');
    const original = stores.shift()!; const dataDirectory = original.directory; original.close();
    const reopened = new Store(dataDirectory); stores.push(reopened); const evidence = new CaseRunStore(reopened);
    expect(evidence.get(result.id)).toEqual(result);
    expect(evidence.interruptRunning()).toBe(1); expect(evidence.get('unfinished').status).toBe('interrupted');
    expect(evidence.get('unfinished').execution?.runId).toBe('unfinished-model-run');
    expect(() => evidence.finish({ ...result, status: 'failed', error: 'rewrite evidence' })).toThrow('only a running');
  });
});

describe('case comparison', () => {
  it('requires identical cases, inputs and model/environment conditions; reports failed assertions', async () => {
    const options = await setup(); const baseline = await runCase(options);
    const candidate = await rerun(options, { target: { ...options.target, version: '2.0.0', digest: caseDigest('v2') }, execute: async () => ({ status: 'completed', output: '{"answer":0}' }) });
    expect(compareCaseRuns(baseline, candidate)).toMatchObject({ comparable: true, passed: false, regressions: [0] });
    const different = await rerun(options, { binding: { ...options.binding, model: 'different' } });
    expect(compareCaseRuns(baseline, different).comparable).toBe(false);
    const changedInput = await rerun(options, { definition: { ...definition, version: '2.0.0', inputs: { files: [], data: { answer: 0 } } } });
    expect(compareCaseRuns(baseline, changedInput).comparable).toBe(false);
  });
});
