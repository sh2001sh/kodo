import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCard, serializeCard } from '../src/agents/card.js';
import { CaseRunStore } from '../src/cases/store.js';
import type { CaseDefinition } from '../src/cases/schema.js';
import { exportPackage } from '../src/packages/archive.js';
import { PackageRegistry } from '../src/packages/registry.js';
import type { InstalledPackage } from '../src/packages/schema.js';
import type { Provider } from '../src/runtime/types.js';
import { TuiController } from '../src/tui/controller.js';
import { createAgentOperations } from '../src/tui/operations.js';
import type { TuiOptions } from '../src/tui/types.js';
import { answer, binding, fixture, scripted, temp } from './helpers.js';

const controllers: TuiController[] = [];
const caseWorkspaces = new Set<string>();
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.close();
  for (const workspace of caseWorkspaces) {
    const relative = path.relative(os.tmpdir(), workspace);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(workspace).startsWith('kodo-tui-case-')) throw new Error('unexpected case workspace');
    await rm(workspace, { recursive: true, force: true });
  }
  caseWorkspaces.clear();
});

function setup(provider: Provider, extra: Partial<TuiOptions> = {}) {
  const env = fixture(provider, ['read', 'write'], { compaction: false, instructions: { global: false } });
  const registry = new PackageRegistry(path.join(env.root, '.packages'));
  const createRun = vi.fn<NonNullable<TuiOptions['createRun']>>(request => env.app.createRun(request));
  const activated: { id: string; version: string; workspace: string }[] = [];
  const options: TuiOptions = {
    app: env.app, workspace: env.root, binding, permissions: ['read', 'write'], permissionMode: 'yolo', registry,
    budget: { maxModelCalls: 1, maxToolCalls: 10, maxChildren: 2 }, createRun,
    activatePackageAt: async (id, version, workspace, signal) => {
      activated.push({ id, version, workspace });
      return await registry.activate(env.app, id, version, { workspace, signal });
    },
    ...extra,
  };
  const controller = new TuiController(options);
  controllers.push(controller);
  return { ...env, registry, options, controller, createRun, activated };
}
type Environment = ReturnType<typeof setup>;
const method = {
  name: 'Evidence reviewer', description: 'Review supplied source material and cite observed evidence.', tools: ['file.read'],
  inputs: ['Source material and the claims to review.'],
  steps: ['Read the supplied source material.', 'Compare each claim with observed evidence.'],
  checks: ['Cite evidence for every conclusion.', 'Report a missing input instead of inventing evidence.'],
};

async function authorConfirmation(env: Environment, output = 'method-draft'): Promise<string> {
  await env.controller.submit(`/agents new "Review source material with evidence." --id local/reviewer --output "${output}" --tools file.read --source-url "https://example.test/reviewer"`);
  const command = env.controller.snapshot().panel?.items?.find(item => item.id === 'confirm')?.command;
  expect(command).toMatch(/^\/agents author-confirm /u);
  return command!;
}

async function install(env: Environment, version = '1.0.0'): Promise<InstalledPackage> {
  const source = temp();
  const card = parseCard(`---
schema_version: 1
id: local/case-agent
version: ${version}
name: Case agent
description: Return the answer from the frozen case input.
capabilities: { tools: [] }
---
Return the frozen input answer as JSON.
`);
  await writeFile(path.join(source, 'AGENT.md'), serializeCard(card), 'utf8');
  const archive = path.join(source, 'agent.zip');
  await exportPackage(source, { schema_version: 1, license: 'MIT', source: { url: 'https://example.test/case-agent' }, files: [{ path: 'AGENT.md', distributable: true }] }, archive);
  return await env.registry.import(archive);
}

async function caseConfirmation(env: Environment): Promise<string> {
  const installed = await install(env);
  const definition: CaseDefinition = {
    schema_version: 1, id: 'local/frozen-answer', version: '1.0.0', name: 'Frozen answer', objective: 'Return the frozen answer as JSON.',
    inputs: { files: [{ path: 'fixture.txt', content: 'Frozen input bytes.\n' }], data: { answer: 42 } },
    assertions: [{ type: 'json', source: 'output', pointer: '/answer', equals: 42 }],
  };
  await writeFile(path.join(env.root, 'frozen-case.json'), JSON.stringify(definition), 'utf8');
  await writeFile(path.join(env.root, 'workspace-only.txt'), 'Keep the original workspace separate.', 'utf8');
  await env.controller.submit(`/agents test ${installed.card.id}@${installed.card.version} frozen-case.json`);
  const command = env.controller.snapshot().panel?.items?.find(item => item.id === 'confirm')?.command;
  expect(command).toMatch(/^\/agents case-confirm /u);
  return command!;
}

describe('TUI metered operation bridge', () => {
  it('records an actual tool-free author run and writes a draft only after complete model output', async () => {
    const complete = vi.fn<Provider['complete']>(async request => {
      expect(request.tools).toEqual([]);
      expect(request.toolChoice).toBe('none');
      expect(request.maxOutputTokens).toBeLessThanOrEqual(4096);
      return answer(JSON.stringify(method));
    });
    const env = setup({ complete });
    const confirm = await authorConfirmation(env);
    expect(complete).not.toHaveBeenCalled();
    expect(existsSync(path.join(env.root, 'method-draft'))).toBe(false);
    await env.controller.submit(confirm);
    const run = env.app.store.run(env.controller.snapshot().runId!);
    const session = env.app.store.session(run.sessionId);
    expect(run).toMatchObject({ status: 'completed', card: { id: 'builtin/tui-authoring', tools: [] }, toolChoice: 'none', scope: { read: [], write: [] } });
    expect(session).toMatchObject({ permissions: [], modelCalls: 1, toolCalls: 0, tokens: 80 });
    expect(env.app.store.calls(run.id)).toMatchObject([{ kind: 'model', status: 'succeeded' }]);
    expect(env.app.store.listRuns(run.sessionId)).toHaveLength(1);
    expect(env.createRun.mock.calls[0]?.[1]).toEqual({ purpose: 'authoring' });
    expect(await readFile(path.join(env.root, 'method-draft', 'AGENT.md'), 'utf8')).toContain('Evidence reviewer');
    expect(existsSync(path.join(env.root, 'method-draft', 'agent.zip'))).toBe(true);
    expect(await env.registry.current('local/reviewer')).toBeUndefined();
  });

  it.each(['model-error', 'invalid-method'] as const)('retains %s evidence and writes no author draft', async failure => {
    const provider = failure === 'model-error'
      ? scripted(async () => { throw new Error('ordinary model failure'); })
      : scripted(answer('not a JSON method'));
    const env = setup(provider);
    const confirm = await authorConfirmation(env, 'failed-draft');
    await expect(env.controller.submit(confirm)).rejects.toThrow();
    const run = env.app.store.run(env.controller.snapshot().runId!);
    expect(run.status).toBe(failure === 'model-error' ? 'failed' : 'completed');
    expect(env.app.store.calls(run.id).filter(call => call.kind === 'model')).toHaveLength(1);
    expect(env.app.store.session(run.sessionId).toolCalls).toBe(0);
    expect(existsSync(path.join(env.root, 'failed-draft'))).toBe(false);
    expect(await env.registry.list()).toEqual([]);
  });

  it.each(['/stop all', '/cancel'])('cancels an in-flight author request with %s, retains its model call and leaves no draft', async command => {
    let started!: () => void;
    const startedRequest = new Promise<void>(resolve => { started = resolve; });
    const env = setup(scripted(async (_request, signal) => {
      started();
      return await new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }));
    const confirm = await authorConfirmation(env, 'cancelled-draft');
    const pending = env.controller.submit(confirm).then(() => undefined, (error: unknown) => error);
    await startedRequest;
    await env.controller.submit(command);
    expect(await pending).toBeInstanceOf(Error);
    const run = env.app.store.run(env.controller.snapshot().runId!);
    expect(['cancelled', 'interrupted']).toContain(run.status);
    expect(env.app.store.calls(run.id).filter(call => call.kind === 'model')).toHaveLength(1);
    expect(env.app.store.session(run.sessionId).toolCalls).toBe(0);
    expect(existsSync(path.join(env.root, 'cancelled-draft'))).toBe(false);
  });

  it.each(['completed', 'failed'] as const)('records the case execution identity before driving a %s model run in its frozen workspace', async outcome => {
    let inspected = false;
    const beforeRun = vi.fn<NonNullable<TuiOptions['beforeRun']>>(async runId => {
      const run = env.app.store.run(runId), session = env.app.store.session(run.sessionId);
      const record = new CaseRunStore(env.app.store).list().items[0]!;
      expect(record).toMatchObject({ status: 'running', execution: { runId }, conditions: { permissions: ['read', 'write'] } });
      expect(env.app.store.calls(runId)).toEqual([]);
      expect(session.workspace).toBe(record.workspace);
      expect(session.workspace).not.toBe(env.root);
      caseWorkspaces.add(session.workspace);
      expect(session.permissions).toEqual(['read', 'write']);
      expect(await readdir(session.workspace)).toEqual(['fixture.txt']);
      expect(await readFile(path.join(session.workspace, 'fixture.txt'), 'utf8')).toBe('Frozen input bytes.\n');
      expect(env.activated).toEqual([{ id: 'local/case-agent', version: '1.0.0', workspace: session.workspace }]);
      expect(run.objective).toContain('Frozen case input data:\n{"answer":42}');
      inspected = true;
    });
    const env: Environment = setup(outcome === 'completed' ? scripted(answer('{"answer":42}')) : scripted(async () => { throw new Error('ordinary model failure'); }), { beforeRun });
    const confirm = await caseConfirmation(env);
    expect(beforeRun).not.toHaveBeenCalled();
    await env.controller.submit(confirm);
    const store = new CaseRunStore(env.app.store), record = store.list().items[0]!;
    caseWorkspaces.add(record.workspace);
    expect(record.execution?.runId, JSON.stringify(record)).toBeTypeOf('string');
    const run = env.app.store.run(record.execution!.runId!);
    expect(inspected).toBe(true);
    expect(record).toMatchObject({ status: outcome === 'completed' ? 'passed' : 'failed', execution: { runId: run.id, status: outcome } });
    expect(store.get(record.id)).toEqual(record);
    expect(env.app.store.calls(run.id).filter(call => call.kind === 'model')).toHaveLength(1);
    expect(env.createRun.mock.calls[0]?.[1]).toEqual({ purpose: 'case' });
    expect(await readFile(path.join(env.root, 'workspace-only.txt'), 'utf8')).toBe('Keep the original workspace separate.');
    expect(existsSync(path.join(env.root, 'fixture.txt'))).toBe(false);
    expect(await env.registry.current('local/case-agent')).toBeUndefined();
  });

  it('requires a fresh case confirmation when the host permission configuration changes', async () => {
    const complete = vi.fn<Provider['complete']>(async () => answer('{"answer":42}'));
    const env = setup({ complete });
    const confirm = await caseConfirmation(env);
    env.options.permissions = ['read'];
    await expect(env.controller.submit(confirm)).rejects.toThrow('permissions');
    expect(complete).not.toHaveBeenCalled();
    expect(env.createRun).not.toHaveBeenCalled();
    expect(new CaseRunStore(env.app.store).list().items).toEqual([]);
  });

  it('previews and confirms authoring and cases with explicitly undefined optional CLI binding fields', async () => {
    const responses = scripted(answer(JSON.stringify(method)), answer('{"answer":42}'));
    const complete = vi.fn<Provider['complete']>((...args) => responses.complete(...args));
    const cliBinding = { ...binding, protocol: undefined, promptCache: undefined };
    const env = setup({ complete }, { binding: cliBinding });
    expect(Object.hasOwn(env.options.binding, 'protocol')).toBe(true);
    expect(Object.hasOwn(env.options.binding, 'promptCache')).toBe(true);
    const author = await authorConfirmation(env, 'cli-binding-draft');
    expect(complete).not.toHaveBeenCalled();
    await env.controller.submit(author);
    const authored = env.app.store.run(env.controller.snapshot().runId!);
    expect(authored.status).toBe('completed');
    expect(existsSync(path.join(env.root, 'cli-binding-draft', 'AGENT.md'))).toBe(true);
    const caseCommand = await caseConfirmation(env);
    expect(complete).toHaveBeenCalledTimes(1);
    await env.controller.submit(caseCommand);
    const record = new CaseRunStore(env.app.store).list().items[0]!;
    caseWorkspaces.add(record.workspace);
    expect(record).toMatchObject({ status: 'passed', execution: { status: 'completed', runId: env.controller.snapshot().runId } });
    expect(record.conditions.model).toEqual({ model: binding.model, baseURL: binding.baseURL, limits: binding.limits });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('compares host policy independently of package versions while including local binding configuration', async () => {
    const env = setup(scripted());
    const first = await install(env), second = await install(env, '2.0.0');
    const { caseHost } = createAgentOperations(env.options, {
      binding, executeRun: async request => await env.app.run(env.app.createRun(request).id),
    });
    expect(first.digest).not.toBe(second.digest);
    const baseline = await caseHost!.hostPolicyDigest(first);
    expect(await caseHost!.hostPolicyDigest(second)).toBe(baseline);
    await env.registry.configure(second.card.id, second.card.version, { mcp: { remote: { url: 'https://example.test/local-binding' } } });
    expect(await caseHost!.hostPolicyDigest(second)).not.toBe(baseline);
    expect(await caseHost!.hostPolicyDigest(first)).toBe(baseline);
    expect(env.createRun).not.toHaveBeenCalled();
  });
});
