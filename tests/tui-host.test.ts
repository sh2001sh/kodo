import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Application } from '../src/application/index.js';
import { createCliTuiOptions, matchingTuiPolicy } from '../src/cli/tui-host.js';
import { readHostState, writeHostState } from '../src/cli/host-state.js';
import type { CliHostSession } from '../src/cli/host-state.js';
import { PackageRegistry } from '../src/packages/registry.js';
import { binding, scripted, temp } from './helpers.js';

const apps: Application[] = [];
afterEach(async () => { vi.unstubAllEnvs(); while (apps.length) await apps.pop()!.shutdown(); });
function setup(command?: string, overrides: Pick<Parameters<typeof createCliTuiOptions>[0], 'package' | 'finalResponse'> = {}) {
  const root = temp();
  const app = new Application(path.join(root, '.state'), scripted(), undefined, { compaction: false, instructions: { global: false } });
  apps.push(app);
  const state: CliHostSession[] = [];
  const select = vi.fn(), attachVerification = vi.fn(), onHost = vi.fn();
  const options = createCliTuiOptions({
    options: { app, workspace: root, binding, permissions: ['read'], registry: new PackageRegistry(path.join(app.store.directory, 'capabilities')) },
    policy: { compaction: false }, state, verificationCommand: command, select, attachVerification, onHost, ...overrides,
  });
  return { root, app, state, options, select, attachVerification, onHost };
}

describe('TUI CLI host integration', () => {
  it('opens a local workspace without credentials or creating a model run', () => {
    vi.stubEnv(binding.apiKeyEnv, '');
    const { app, state } = setup();
    expect(app.store.listRuns()).toEqual([]);
    expect(state).toEqual([]);
  });

  it('persists new session bindings and the fixed validator before any model execution', async () => {
    vi.stubEnv(binding.apiKeyEnv, 'local-fixture-only');
    const argv = [process.execPath, '--version'];
    const f = setup(JSON.stringify(argv));
    const run = await f.options.createRun!({ objective: 'Inspect README', workspace: f.root, binding, permissions: ['read'] });
    expect(f.app.store.calls(run.id)).toHaveLength(0);
    expect(f.app.store.session(run.sessionId).verificationCommand).toEqual({ program: argv[0], args: ['--version'] });
    expect(readHostState(f.app.store.directory)).toEqual([{ sessionId: run.sessionId, runIds: [run.id], questionIds: [], compaction: false, tuiApproval: true }]);
    expect(f.attachVerification).toHaveBeenCalledWith(run.id);
    expect(f.select).toHaveBeenCalledWith(run.id);
    await expect(f.options.restore!(run)).resolves.toBeUndefined();
    expect(f.app.store.calls(run.id)).toHaveLength(0);
  });

  it('requires configured model and environment credentials only when creating a task', async () => {
    const f = setup();
    vi.stubEnv(binding.apiKeyEnv, '');
    const request = { objective: 'Read the project', workspace: f.root, binding, permissions: ['read' as const] };
    await expect(f.options.createRun!({ ...request, binding: { ...binding, model: '' } })).rejects.toMatchObject({ code: 'MODEL_CONFIG' });
    await expect(f.options.createRun!(request)).rejects.toMatchObject({ code: 'MODEL_CREDENTIAL' });
    expect(f.app.store.listRuns()).toHaveLength(0);
  });

  it('keeps authoring separate from the selected package and fixed project completion command', async () => {
    vi.stubEnv(binding.apiKeyEnv, 'local-fixture-only');
    const f = setup(JSON.stringify([process.execPath, '--version']), {
      finalResponse: 'optional',
      package: { id: 'local/source', version: '1.0.0', digest: 'a'.repeat(64), stdioWrite: false, stdioNetwork: 'none' },
    });
    const request = { objective: 'Generate a method draft', workspace: f.root, binding, permissions: [], finalResponse: 'required' as const };
    const author = await f.options.createRun!(request, { purpose: 'authoring' });
    f.options.beforeRun!(author.id);
    expect(f.app.store.run(author.id).finalResponse).toBe('required');
    expect(f.app.store.session(author.sessionId).verificationCommand).toBeUndefined();
    expect(readHostState(f.app.store.directory).find(host => host.sessionId === author.sessionId)?.package).toBeUndefined();
    const task = await f.options.createRun!({ ...request, objective: 'An ordinary project task' });
    expect(f.app.store.run(task.id).finalResponse).toBe('optional');
    expect(f.app.store.session(task.sessionId).verificationCommand).toEqual({ program: process.execPath, args: ['--version'] });
    expect(readHostState(f.app.store.directory).find(host => host.sessionId === task.sessionId)?.package?.id).toBe('local/source');
    expect(f.options.caseCommands).toEqual({ default: { program: process.execPath, args: ['--version'] } });
    expect(f.app.store.calls(author.id)).toHaveLength(0);
  });

  it('requires the original host policy and workspace before executing a historical session', async () => {
    vi.stubEnv(binding.apiKeyEnv, 'local-fixture-only');
    const f = setup();
    const run = await f.options.createRun!({ objective: 'Read', workspace: f.root, binding, permissions: ['read'] });
    f.state[0]!.memory = true;
    await expect(f.options.restore!(run)).rejects.toMatchObject({ code: 'CAPABILITY_CHANGED' });
    delete f.state[0]!.memory;
    const session = f.app.store.session(run.sessionId);
    f.app.store.putSession({ ...session, workspace: temp() });
    await expect(f.options.restore!(run)).rejects.toMatchObject({ code: 'CAPABILITY_CHANGED' });
    expect(f.app.store.calls(run.id)).toHaveLength(0);
  });

  it('adopts an old historical session into interactive approvals when reattaching it', async () => {
    const f = setup();
    const run = f.app.createRun({ objective: 'Read the project', workspace: f.root, binding, permissions: ['read'] });
    f.state.push({ sessionId: run.sessionId, runIds: [run.id], questionIds: [], compaction: false });
    writeHostState(f.app.store.directory, f.state);
    expect(readHostState(f.app.store.directory)[0]!.tuiApproval).toBeUndefined();
    await f.options.restore!(run);
    expect(readHostState(f.app.store.directory)).toEqual([{ sessionId: run.sessionId, runIds: [run.id], questionIds: [], compaction: false, tuiApproval: true }]);
    expect(f.app.store.calls(run.id)).toHaveLength(0);
  });

  it.each([false, true])('keeps package stdio grants independent of TUI tool permissions: %s', async stdioWrite => {
    vi.stubEnv(binding.apiKeyEnv, 'local-fixture-only');
    const f = setup();
    const source = f.app.createRun({ objective: 'Provide a fixture card', workspace: f.root, binding, permissions: ['read'] });
    const activate = vi.fn(async () => source.card);
    vi.spyOn(f.options.registry, 'inspect').mockResolvedValue({ root: f.root, card: source.card, digest: 'a'.repeat(64), bytes: 0, manifest: { schema_version: 1, license: 'MIT', source: { url: 'https://example.test/fixture' }, files: [] } });
    const options = createCliTuiOptions({
      options: { ...f.options, permissions: ['read', 'write', 'exec'], activatePackage: activate },
      policy: { compaction: false }, state: f.state, stdioWrite, select: f.select, attachVerification: f.attachVerification, onHost: f.onHost,
    });
    await options.activatePackage!('local/fixture', '1.0.0');
    const run = await options.createRun!({ objective: 'Use the activated package', workspace: f.root, binding, permissions: ['read', 'write', 'exec'] });
    expect(readHostState(f.app.store.directory)[0]!.package).toEqual({ id: 'local/fixture', version: '1.0.0', digest: 'a'.repeat(64), stdioWrite, stdioNetwork: 'none' });
    await expect(options.restore!(run)).resolves.toBeUndefined();
    const restored = f.state.find(host => host.sessionId === run.sessionId)!;
    restored.package!.stdioWrite = !stdioWrite;
    activate.mockClear();
    await expect(options.restore!(run)).rejects.toMatchObject({ code: 'CAPABILITY_CHANGED', message: expect.stringContaining('original package stdio permissions') });
    expect(activate).not.toHaveBeenCalled();
    expect(f.app.store.calls(run.id)).toHaveLength(0);
  });

  it('blocks plain execution for TUI-approved sessions even when the saved run and question index is stale', async () => {
    const f = setup();
    const run = f.app.createRun({ objective: 'Wait for interactive approval', workspace: f.root, binding, permissions: ['read', 'write', 'exec'] });
    const question = f.app.store.putMessage({ id: 'question:plain-approval-guard', sessionId: run.sessionId, from: run.id, to: 'user', kind: 'question', content: 'Continue?' });
    const directory = f.app.store.directory;
    writeHostState(directory, [{ sessionId: run.sessionId, runIds: [], questionIds: [], compaction: false, tuiApproval: true }]);
    apps.splice(apps.indexOf(f.app), 1);
    await f.app.shutdown();
    const entry = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
    const cli = (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [entry, ...args, '--data-dir', directory], { windowsHide: true, env: { ...process.env, KODO_MODEL: '', KODO_API_KEY: '', OPENAI_API_KEY: '' } });
      let out = '', err = '';
      child.stdout.on('data', chunk => { out += String(chunk); }); child.stderr.on('data', chunk => { err += String(chunk); });
      child.on('error', reject); child.on('close', code => resolve({ code, out, err }));
    });
    for (const args of [
      ['resume', run.id], ['continue', run.id], ['input', run.id, '--text', 'Continue'], ['answer', question.id, '--text', 'Yes'],
      ['spawn', run.sessionId, '--objective', 'Continue'], ['rewind', run.id, '--to=-1'],
    ]) {
      const result = await cli(args);
      expect(result.code, result.err).toBe(1);
      expect(result.err).toContain('TUI_APPROVAL_REQUIRED: Open kodo and use /resume');
      expect(result.out).toBe('');
    }
    const inspected = await cli(['inspect', run.id, '--json']);
    expect(inspected.code, inspected.err).toBe(0);
    expect(JSON.parse(inspected.out).calls).toEqual([]);
    const interrupted = await cli(['interrupt', run.id, '--json']);
    expect(interrupted.code, interrupted.err).toBe(0);
    const cancelled = await cli(['cancel', run.id, '--json']);
    expect(cancelled.err).not.toContain('TUI_APPROVAL_REQUIRED');
    expect(cancelled.code).toBe(130);
    const reopened = new Application(directory, scripted(), undefined, { compaction: false, instructions: { global: false } });
    apps.push(reopened);
    expect(reopened.store.calls(run.id)).toEqual([]);
    expect(reopened.store.answer(question.id)).toBeUndefined();
    expect(reopened.store.listRuns(run.sessionId)).toHaveLength(1);
  });

  it('compares configuration values independently of object key order and preserves old off defaults', () => {
    expect(matchingTuiPolicy({}, { compaction: false, memory: false })).toBe(true);
    expect(matchingTuiPolicy({ compaction: false }, { compaction: { strategy: 'summary' } })).toBe(false);
    expect(matchingTuiPolicy({ agents: { agentFactors: { A: true, B: false } } }, { agents: { agentFactors: { B: false, A: true } } })).toBe(true);
  });

  it('rejects malformed verification configuration before creating a session', () => {
    expect(() => setup('["node",4]')).toThrow('string arguments');
    expect(() => setup('not json')).toThrow('JSON argv');
  });
});
