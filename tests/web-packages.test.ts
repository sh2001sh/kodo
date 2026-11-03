import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Application, PackageRegistry, exportPackage } from '../src/application/index.js';
import type { PackageDeclaration } from '../src/application/index.js';
import { PackagePanel } from '../src/web/packages.js';
import type { PackageOverview, PackagePanelOptions } from '../src/web/packages.js';
import { createLocalServer } from '../src/web/index.js';
import type { LocalServerHandle, LocalServerOptions } from '../src/web/index.js';
import { binding, temp } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) { try { await cleanups.pop()!(); } catch { /* best-effort teardown */ } }
  vi.restoreAllMocks();
});
const track = (cleanup: () => Promise<void>): void => { cleanups.push(cleanup); };
function application(root: string): Application {
  const app = new Application(path.join(root, 'data'));
  track(async () => { await app.shutdown(); });
  return app;
}
function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(action => { resolve = action; });
  return { promise, resolve };
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('aborted'));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); }, error => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

interface FixtureOptions { id?: string; version?: string; tools?: boolean; mcp?: boolean; dependencies?: Record<string, string> }
/** Build a real installed package through the export/import pipeline used by the CLI. */
async function install(registry: PackageRegistry, options: FixtureOptions = {}): Promise<Awaited<ReturnType<PackageRegistry['inspect']>>> {
  const id = options.id ?? 'example/echo';
  const version = options.version ?? '1.0.0';
  const name = id.slice(id.indexOf('/') + 1);
  const source = temp();
  const files = ['AGENT.md'];
  const cardTools: string[] = [];
  const resources: NonNullable<PackageDeclaration['resources']> = {};
  if (options.tools) {
    files.push('tool.json', 'tool.mjs'); cardTools.push('custom.echo');
    writeFileSync(path.join(source, 'tool.json'), JSON.stringify({ format: 'kodo-tool/v1', name: 'custom.echo', description: 'Fixture read tool', permission: 'read', effect: 'read', parameters: { type: 'object' } }));
    writeFileSync(path.join(source, 'tool.mjs'), 'export default () => ({ echo: true });');
    resources.tools = [{ name: 'custom.echo', descriptor: 'tool.json', entry: 'tool.mjs' }];
  }
  if (options.mcp) {
    cardTools.push('mcp.remote.echo');
    resources.mcp = [{ id: 'remote', transport: 'http', url: 'https://mcp.example.test/template', tools: { echo: { permission: 'read', effect: 'read' } } }];
  }
  writeFileSync(path.join(source, 'AGENT.md'), `---\nschema_version: 1\nid: ${id}\nversion: ${version}\nname: Package ${name}\ndescription: Fixture capability package\ncapabilities:\n  tools: [${cardTools.join(', ')}]\n---\nFollow the approved package instructions.\n`);
  const declaration: PackageDeclaration = {
    schema_version: 1,
    license: 'MIT',
    source: { url: `https://example.test/${name}` },
    files: files.map(file => ({ path: file, distributable: true as const })),
    ...(Object.keys(resources).length ? { resources } : {}),
    ...(options.dependencies ? { requirements: { dependencies: options.dependencies } } : {}),
  };
  const archive = path.join(temp(), `${name}-${version}.zip`);
  await exportPackage(source, declaration, archive);
  return await registry.import(archive);
}

describe('capability package panel', () => {
  it('projects diagnostics, default version, provenance and versions without host paths', async () => {
    const registry = new PackageRegistry(temp());
    const first = await install(registry, { tools: true });
    const second = await install(registry, { version: '1.1.0', tools: true });
    const dependency = await install(registry, { id: 'example/deps', dependencies: { 'left-pad': '^1.0.0' } });
    await registry.adopt('example/echo', '1.0.0');
    await registry.adopt('example/echo', '1.1.0');
    const panel = new PackagePanel({ registry, runtime: { id: 'example/echo', version: '1.1.0', digest: second.digest }, prepare: true });
    const app = application(temp());
    const overview = await panel.overview(app, () => true);
    expect(overview.enabled).toBe(true);
    expect(overview.actions).toEqual({ prepare: true, adopt: false });
    expect(overview.runtime).toEqual({ id: 'example/echo', version: '1.1.0', digest: second.digest });
    expect(overview.errors).toEqual([]);
    expect(overview.packages.map(group => group.id)).toEqual(['example/deps', 'example/echo']);
    const echo = overview.packages[1]!;
    expect(echo.defaultVersion).toBe('1.1.0');
    expect(echo.previousVersion).toBe('1.0.0');
    expect(typeof echo.adoptedAt).toBe('string');
    expect(echo.versions.map(view => view.version)).toEqual(['1.0.0', '1.1.0']);
    const latest = echo.versions[1]!;
    expect(latest.digest).toBe(second.digest);
    expect(latest.card).toEqual({ id: 'example/echo', version: '1.1.0', digest: second.card.digest, name: 'Package echo', description: 'Fixture capability package', tools: ['custom.echo'], skills: [] });
    expect(latest.status).toBe('ready');
    expect(latest.reasons).toEqual([]);
    expect(latest.resources).toEqual({ tools: 1, skills: 0, mcp: 0 });
    expect(latest.examples).toBe(0);
    expect(latest.prepared).toEqual({ ready: false, treeDigest: null });
    expect(latest.bindingsConfigured).toBe(true);
    expect(latest.provenance).toMatchObject({ source: { url: 'https://example.test/echo' }, archiveName: 'echo-1.1.0.zip' });
    expect(first.digest).not.toBe(first.card.digest);
    const deps = overview.packages[0]!;
    expect(deps.defaultVersion).toBeNull();
    expect(deps.previousVersion).toBeNull();
    expect(deps.adoptedAt).toBeNull();
    expect(deps.versions[0]!.status).toBe('imported');
    expect(deps.versions[0]!.reasons).toContain('dependencies require explicit preparation');
    expect(deps.versions[0]!.requirements).toEqual({ dependencies: { 'left-pad': '^1.0.0' } });
    expect(overview.running).toEqual([]);
    expect(overview.prepareJobs).toEqual([]);
    const serialized = JSON.stringify(overview);
    expect(serialized).not.toContain(registry.root);
    expect(serialized).not.toContain('"binding"');
    expect(dependency.digest).toBeTruthy();
  });

  it('conceals local MCP binding contents while reporting configuration', async () => {
    const registry = new PackageRegistry(temp());
    await install(registry, { mcp: true });
    await registry.configure('example/echo', '1.0.0', { mcp: { remote: { url: 'https://mcp.example.test/endpoint' } } });
    const panel = new PackagePanel({ registry });
    const overview = await panel.overview(application(temp()), () => true);
    const view = overview.packages[0]!.versions[0]!;
    expect(view.status).toBe('ready');
    expect(view.reasons).toEqual([]);
    expect(view.bindingsConfigured).toBe(true);
    expect(view.resources.mcp).toBe(1);
    const serialized = JSON.stringify(overview);
    expect(serialized).not.toContain('mcp.example.test/endpoint');
    expect(serialized).not.toContain(registry.root);
    expect(serialized).not.toContain('"binding"');
  });

  it('isolates an unreadable installed package instead of collapsing the overview', async () => {
    const registry = new PackageRegistry(temp());
    await install(registry, { id: 'example/good' });
    const broken = await install(registry, { id: 'example/broken' });
    appendFileSync(path.join(broken.root, 'AGENT.md'), 'tampered\n');
    const panel = new PackagePanel({ registry });
    const overview = await panel.overview(application(temp()), () => true);
    expect(overview.packages.map(group => group.id)).toEqual(['example/good']);
    expect(overview.errors).toHaveLength(1);
    expect(overview.errors[0]).toContain('example/broken@1.0.0');
    expect(overview.errors[0]).not.toContain(registry.root);
  });

  it('lists only accessible sessions using installed cards, marks digest mismatches stale and caps at 200', async () => {
    const registry = new PackageRegistry(temp());
    const installed = await install(registry);
    const root = temp(); const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
    const app = application(root);
    const panel = new PackagePanel({ registry });
    const main = app.createRun({ objective: 'main package task', workspace, binding, card: installed.card });
    app.store.updateRun(main.id, { createdAt: '2026-01-01T00:00:00.000Z' });
    const childId = 'child-package-run';
    app.store.putRun({ ...app.store.run(main.id), id: childId, parentId: main.id, objective: 'child package task', createdAt: '2026-01-02T00:00:00.000Z' });
    const stale = app.createRun({ objective: 'stale package task', workspace, binding, card: installed.card });
    app.store.updateRun(stale.id, { card: { ...installed.card, digest: 'f'.repeat(64) }, createdAt: '2026-01-03T00:00:00.000Z' });
    const missing = app.createRun({ objective: 'missing version task', workspace, binding, card: installed.card });
    app.store.updateRun(missing.id, { card: { ...installed.card, version: '9.9.9' }, createdAt: '2026-01-04T00:00:00.000Z' });
    const foreignWorkspace = path.join(root, 'other'); mkdirSync(foreignWorkspace);
    const foreign = app.createRun({ objective: 'invisible task', workspace: foreignWorkspace, binding, card: installed.card });
    const allowed = (sessionId: string): boolean => sessionId === main.sessionId || sessionId === stale.sessionId || sessionId === missing.sessionId;
    const overview = await panel.overview(app, allowed);
    expect(overview.running.map(run => run.runId)).toEqual([missing.id, stale.id, childId, main.id]);
    const [missingView, staleView, childView, mainView] = overview.running;
    expect(missingView).toMatchObject({ cardId: 'example/echo', cardVersion: '9.9.9', installedDigest: null, stale: false, role: 'main', status: 'queued' });
    expect(staleView).toMatchObject({ cardDigest: 'f'.repeat(64), installedDigest: installed.card.digest, stale: true, role: 'main' });
    expect(childView).toMatchObject({ role: 'child', objective: 'child package task', stale: false });
    expect(mainView).toMatchObject({ role: 'main', objective: 'main package task', status: 'queued' });
    expect(mainView!.lastEventAt).toBe(app.store.events(main.id).at(-1)!.time);
    expect(overview.running.some(run => run.sessionId === foreign.sessionId)).toBe(false);
    // Fabricated bulk runs verify the projection cap without executing anything.
    for (let index = 0; index < 205; index++) {
      app.store.putRun({ ...app.store.run(main.id), id: `bulk-${String(index).padStart(3, '0')}`, objective: `bulk ${index}`, createdAt: new Date(Date.UTC(2030, 0, 1, 0, 0, index)).toISOString() });
    }
    const capped = await panel.overview(app, () => true);
    expect(capped.running).toHaveLength(200);
    expect(capped.running[0]!.runId).toBe('bulk-204');
    expect(capped.running.at(-1)!.runId).toBe('bulk-005');
  });

  it('switches the default pointer through adopt/rollback without touching fixed run cards', async () => {
    const registry = new PackageRegistry(temp());
    const first = await install(registry);
    const second = await install(registry, { version: '1.1.0' });
    const root = temp(); const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
    const app = application(root);
    const run = app.createRun({ objective: 'fixed card task', workspace, binding, card: first.card });
    const panel = new PackagePanel({ registry, adopt: true });
    expect((await panel.adopt('example/echo', '1.0.0')).version).toBe('1.0.0');
    await panel.adopt('example/echo', '1.1.0');
    const adopted = await panel.overview(app, () => true);
    expect(adopted.packages[0]).toMatchObject({ defaultVersion: '1.1.0', previousVersion: '1.0.0' });
    expect(adopted.running).toHaveLength(1);
    expect(adopted.running[0]).toMatchObject({ cardId: 'example/echo', cardVersion: '1.0.0', stale: false });
    expect(adopted.running[0]!.cardDigest).toBe(first.card.digest);
    expect(app.store.run(run.id).card).toEqual(first.card);
    expect(second.card.digest).not.toBe(first.card.digest);
    expect((await panel.rollback('example/echo')).version).toBe('1.0.0');
    expect((await panel.overview(app, () => true)).packages[0]!.defaultVersion).toBe('1.0.0');
    const disabled = new PackagePanel({ registry });
    await expect(disabled.adopt('example/echo', '1.0.0')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(panel.adopt('BAD', '1.0.0')).rejects.toMatchObject({ code: 'ARGUMENTS' });
    await expect(panel.adopt('example/echo', '1.0')).rejects.toMatchObject({ code: 'ARGUMENTS' });
    await expect(panel.adopt('example/missing', '1.0.0')).rejects.toMatchObject({ code: 'PACKAGE_NOT_FOUND' });
    await expect(panel.rollback('example/missing')).rejects.toMatchObject({ code: 'PACKAGE_NOT_FOUND' });
  });

  it('reports prepare phases, serializes jobs and reuses a queued or running job', async () => {
    const registry = new PackageRegistry(temp());
    await install(registry);
    await install(registry, { version: '1.1.0' });
    const panel = new PackagePanel({ registry, prepare: true });
    const firstGate = deferred(); const secondGate = deferred(); const thirdGate = deferred();
    const spy = vi.spyOn(registry, 'prepareDependencies').mockImplementation(async (_id, _version, options = {}) => {
      options.onProgress?.({ phase: 'validating' });
      await abortable(firstGate.promise, options.signal);
      options.onProgress?.({ phase: 'dependencies' });
      await abortable(secondGate.promise, options.signal);
      options.onProgress?.({ phase: 'verifying' });
      await abortable(thirdGate.promise, options.signal);
      options.onProgress?.({ phase: 'committing' });
      return 'prepared-root';
    });
    const running = panel.prepare('example/echo', '1.0.0');
    expect(panel.job(running.jobId)).toMatchObject({ status: 'running', phase: 'validating', packageId: 'example/echo', version: '1.0.0', error: null, finishedAt: null });
    expect(panel.job(running.jobId)!.startedAt).not.toBeNull();
    expect(panel.prepare('example/echo', '1.0.0').jobId).toBe(running.jobId);
    const queued = panel.prepare('example/echo', '1.1.0');
    expect(queued.jobId).not.toBe(running.jobId);
    expect(panel.job(queued.jobId)).toMatchObject({ status: 'queued', phase: 'queued', startedAt: null, finishedAt: null });
    const overview = await panel.overview(application(temp()), () => true);
    expect(overview.prepareJobs.map(job => job.id)).toEqual([running.jobId, queued.jobId]);
    firstGate.resolve();
    await vi.waitFor(() => { expect(panel.job(running.jobId)?.phase).toBe('dependencies'); });
    secondGate.resolve();
    await vi.waitFor(() => { expect(panel.job(running.jobId)?.phase).toBe('verifying'); });
    thirdGate.resolve();
    await vi.waitFor(() => { expect(panel.job(running.jobId)).toMatchObject({ status: 'succeeded', phase: 'done' }); });
    expect(panel.job(running.jobId)!.finishedAt).not.toBeNull();
    await vi.waitFor(() => { expect(panel.job(queued.jobId)?.status).toBe('succeeded'); });
    expect(panel.job(queued.jobId)!.startedAt).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('keeps prepared failures path-free and exposes them through job views', async () => {
    const registry = new PackageRegistry(temp());
    await install(registry);
    const panel = new PackagePanel({ registry, prepare: true });
    vi.spyOn(registry, 'prepareDependencies').mockRejectedValue(new Error(`sandboxed npm ci failed at ${registry.root}\\prepared\\tree: ENOENT; see /home/private/npm-debug.log`));
    const job = panel.prepare('example/echo', '1.0.0');
    await vi.waitFor(() => { expect(panel.job(job.jobId)?.status).toBe('failed'); });
    const view = panel.job(job.jobId)!;
    expect(view.phase).toBe('failed');
    expect(view.finishedAt).not.toBeNull();
    expect(view.error).toContain('sandboxed npm ci failed');
    expect(view.error).toContain('[package-registry]');
    expect(view.error).not.toContain(registry.root);
    expect(view.error).not.toContain('/home/private');
    expect(JSON.stringify(panel.job(job.jobId))).not.toContain(registry.root);
    const retried = panel.prepare('example/echo', '1.0.0');
    expect(retried.jobId).not.toBe(job.jobId);
    await vi.waitFor(() => { expect(panel.job(retried.jobId)?.status).toBe('failed'); });
    const disabled = new PackagePanel({ registry });
    expect(() => disabled.prepare('example/echo', '1.0.0')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => panel.prepare('BAD', '1.0.0')).toThrow(expect.objectContaining({ code: 'ARGUMENTS' }));
    expect(await panel.has('example/echo', '1.0.0')).toBe(true);
    expect(await panel.has('example/missing', '1.0.0')).toBe(false);
    await expect(panel.has('BAD', '1.0.0')).rejects.toMatchObject({ code: 'ARGUMENTS' });
    expect(panel.job('unknown-job')).toBeUndefined();
  });

  it('cancels queued and running preparations on close and waits for settlement', async () => {
    const registry = new PackageRegistry(temp());
    await install(registry);
    await install(registry, { version: '1.1.0' });
    const panel = new PackagePanel({ registry, prepare: true });
    vi.spyOn(registry, 'prepareDependencies').mockImplementation(async (_id, _version, options = {}) => {
      options.onProgress?.({ phase: 'validating' });
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) { reject(new Error('cancelled')); return; }
        options.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
      return 'prepared-root';
    });
    const running = panel.prepare('example/echo', '1.0.0');
    const queued = panel.prepare('example/echo', '1.1.0');
    await vi.waitFor(() => { expect(panel.job(running.jobId)?.status).toBe('running'); });
    await panel.close();
    expect(panel.job(running.jobId)).toMatchObject({ status: 'failed', phase: 'failed', error: 'dependency preparation was cancelled' });
    expect(panel.job(running.jobId)!.finishedAt).not.toBeNull();
    expect(panel.job(queued.jobId)).toMatchObject({ status: 'failed', phase: 'failed', startedAt: null });
    expect(() => panel.prepare('example/echo', '1.0.0')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    await panel.close();
  });
});

async function login(server: LocalServerHandle): Promise<{ cookie: string; csrf: string }> {
  const response = await fetch(`${server.origin}/api/auth`, { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: server.startupSecret }) });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const { csrf } = await response.json() as { csrf: string };
  return { cookie, csrf };
}
async function startServer(registry: PackageRegistry, packages: Partial<PackagePanelOptions> | undefined, extra: Partial<LocalServerOptions> = {}) {
  const root = temp(); const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
  const app = application(root);
  const server = await createLocalServer(app, { workspace, binding, permissions: ['read'], ...(packages === undefined ? {} : { packages: { registry, ...packages } }), ...extra });
  track(async () => { await server.close(); });
  const credentials = await login(server);
  const headers = (more: Record<string, string> = {}): Record<string, string> => ({ Cookie: credentials.cookie, Origin: server.origin, 'Content-Type': 'application/json', 'X-Kodo-CSRF': credentials.csrf, ...more });
  return {
    app, workspace, server, credentials,
    get: (url: string): Promise<Response> => fetch(server.origin + url, { headers: headers() }),
    post: (url: string, body: unknown, more: Record<string, string> = {}): Promise<Response> => fetch(server.origin + url, { method: 'POST', headers: headers(more), body: JSON.stringify(body) }),
    rawPost: (url: string, body: unknown, more: Record<string, string>): Promise<Response> => fetch(server.origin + url, { method: 'POST', headers: more, body: JSON.stringify(body) }),
  };
}

describe('capability package HTTP surface', () => {
  it('serves an authenticated overview with fixed run cards and no bindings or host paths', async () => {
    const registry = new PackageRegistry(temp());
    const first = await install(registry);
    const second = await install(registry, { version: '1.1.0' });
    await registry.adopt('example/echo', '1.0.0');
    await registry.adopt('example/echo', '1.1.0');
    const web = await startServer(registry, { enabled: true, runtime: { id: 'example/echo', version: '1.1.0', digest: second.digest }, prepare: true, adopt: true });
    const run = web.app.createRun({ objective: 'fixed package card', workspace: web.workspace, binding, card: first.card });
    const unauthenticated = await fetch(`${web.server.origin}/api/packages`);
    expect(unauthenticated.status).toBe(401);
    const response = await web.get('/api/packages');
    expect(response.status).toBe(200);
    const overview = await response.json() as PackageOverview;
    expect(overview.enabled).toBe(true);
    expect(overview.actions).toEqual({ prepare: true, adopt: true });
    expect(overview.runtime).toEqual({ id: 'example/echo', version: '1.1.0', digest: second.digest });
    expect(overview.errors).toEqual([]);
    expect(overview.packages).toHaveLength(1);
    expect(overview.packages[0]).toMatchObject({ id: 'example/echo', defaultVersion: '1.1.0', previousVersion: '1.0.0' });
    expect(overview.packages[0]!.versions.map(version => version.status)).toEqual(['ready', 'ready']);
    expect(overview.running).toHaveLength(1);
    expect(overview.running[0]).toMatchObject({ runId: run.id, cardVersion: '1.0.0', installedDigest: first.card.digest, stale: false, role: 'main' });
    expect(typeof overview.running[0]!.lastEventAt).toBe('string');
    const text = JSON.stringify(overview);
    expect(text).not.toContain(registry.root);
    expect(text).not.toContain('"binding"');
    expect(text).not.toContain('apiKeyEnv');
    expect(text).not.toContain('capability-package-registry');
  });

  it('gates package actions behind host switches and validates identities', async () => {
    const registry = new PackageRegistry(temp());
    await install(registry);
    await install(registry, { version: '1.1.0' });
    await registry.adopt('example/echo', '1.0.0');
    const gate = deferred();
    const spy = vi.spyOn(registry, 'prepareDependencies').mockImplementation(async (_id, _version, options = {}) => {
      options.onProgress?.({ phase: 'validating' });
      await abortable(gate.promise, options.signal);
      options.onProgress?.({ phase: 'dependencies' });
      return 'prepared-root';
    });
    const web = await startServer(registry, { enabled: true, prepare: true, adopt: true });
    const prepared = await web.post('/api/packages/example/echo/1.0.0/prepare', {});
    expect(prepared.status).toBe(202);
    const { jobId } = await prepared.json() as { jobId: string };
    expect(spy).toHaveBeenCalledTimes(1);
    const running = await web.get(`/api/packages/jobs/${jobId}`);
    expect(running.status).toBe(200);
    expect(await running.json()).toMatchObject({ id: jobId, status: 'running', phase: 'validating', packageId: 'example/echo', version: '1.0.0' });
    const reused = await web.post('/api/packages/example/echo/1.0.0/prepare', {});
    expect((await reused.json() as { jobId: string }).jobId).toBe(jobId);
    gate.resolve();
    await vi.waitFor(async () => {
      const job = await (await web.get(`/api/packages/jobs/${jobId}`)).json() as { status: string };
      expect(job.status).toBe('succeeded');
    });
    expect((await web.get('/api/packages/jobs/unknown-job')).status).toBe(404);
    const adopted = await web.post('/api/packages/example/echo/adopt', { version: '1.1.0' });
    expect(adopted.status).toBe(200);
    expect((await adopted.json() as { pointer: { version: string; digest: string } }).pointer).toMatchObject({ version: '1.1.0' });
    const rollback = await web.post('/api/packages/example/echo/rollback', {});
    expect(rollback.status).toBe(200);
    expect((await rollback.json() as { pointer: { version: string } }).pointer.version).toBe('1.0.0');
    expect((await web.get('/api/packages/jobs/' + jobId)).status).toBe(200);
    const disabled = await startServer(registry, { enabled: true, prepare: false, adopt: false });
    expect((await disabled.post('/api/packages/example/echo/1.0.0/prepare', {})).status).toBe(404);
    expect((await disabled.post('/api/packages/example/echo/adopt', { version: '1.0.0' })).status).toBe(404);
    expect((await disabled.post('/api/packages/example/echo/rollback', {})).status).toBe(404);
    expect(await (await disabled.get('/api/packages')).json()).toMatchObject({ actions: { prepare: false, adopt: false } });
    expect((await web.post('/api/packages/example/missing/1.0.0/prepare', {})).status).toBe(404);
    expect((await web.post('/api/packages/example/echo/9.9.9/prepare', {})).status).toBe(404);
    expect((await web.post('/api/packages/BAD/name/1.0.0/prepare', {})).status).toBe(400);
    expect((await web.post('/api/packages/example/missing/adopt', { version: '1.0.0' })).status).toBe(404);
    expect((await web.post('/api/packages/example/echo/adopt', { version: '1.0' })).status).toBe(400);
    expect((await web.post('/api/packages/example/echo/adopt', {})).status).toBe(400);
    const missingCsrf = await web.rawPost('/api/packages/example/echo/adopt', { version: '1.0.0' }, { Cookie: web.credentials.cookie, Origin: web.server.origin, 'Content-Type': 'application/json' });
    expect(missingCsrf.status).toBe(403);
    const crossOrigin = await web.rawPost('/api/packages/example/echo/adopt', { version: '1.0.0' }, { Cookie: web.credentials.cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json', 'X-Kodo-CSRF': web.credentials.csrf });
    expect(crossOrigin.status).toBe(403);
  });

  it('keeps the panel disabled by default and returns 404 for every package action', async () => {
    const registry = new PackageRegistry(temp());
    await install(registry);
    const web = await startServer(registry, undefined);
    const response = await web.get('/api/packages');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false, actions: { prepare: false, adopt: false }, runtime: null, packages: [], running: [], prepareJobs: [], errors: [] });
    expect((await web.post('/api/packages/example/echo/1.0.0/prepare', {})).status).toBe(404);
    expect((await web.post('/api/packages/example/echo/adopt', { version: '1.0.0' })).status).toBe(404);
    expect((await web.get('/api/packages/jobs/unknown')).status).toBe(404);
    expect((await web.get('/api/packages/jobs/unknown')).status).toBe(404);
    const explicitlyDisabled = await startServer(registry, { enabled: false, prepare: true, adopt: true });
    expect(await (await explicitlyDisabled.get('/api/packages')).json()).toMatchObject({ enabled: false });
    expect((await explicitlyDisabled.post('/api/packages/example/echo/1.0.0/prepare', {})).status).toBe(404);
  });

  it('switching the adopted version through HTTP leaves running records unchanged', async () => {
    const registry = new PackageRegistry(temp());
    const first = await install(registry);
    await install(registry, { version: '1.1.0' });
    await registry.adopt('example/echo', '1.0.0');
    const web = await startServer(registry, { enabled: true, adopt: true });
    const run = web.app.createRun({ objective: 'card stays fixed', workspace: web.workspace, binding, card: first.card });
    const adopted = await web.post('/api/packages/example/echo/adopt', { version: '1.1.0' });
    expect(adopted.status).toBe(200);
    const overview = await (await web.get('/api/packages')).json() as PackageOverview;
    expect(overview.packages[0]!.defaultVersion).toBe('1.1.0');
    expect(overview.running).toHaveLength(1);
    expect(overview.running[0]).toMatchObject({ runId: run.id, cardVersion: '1.0.0', stale: false });
    expect(web.app.store.run(run.id).card).toEqual(first.card);
    const rolled = await web.post('/api/packages/example/echo/rollback', {});
    expect((await rolled.json() as { pointer: { version: string } }).pointer.version).toBe('1.0.0');
    expect((await (await web.get('/api/packages')).json() as PackageOverview).packages[0]!.defaultVersion).toBe('1.0.0');
    expect(web.app.store.run(run.id).card.version).toBe('1.0.0');
  });
});
