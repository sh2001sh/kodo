import { storageTestConnection } from '../src/storage/test-access.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { createLocalServer } from '../src/web/index.js';
import type { LocalServerHandle, LocalServerOptions } from '../src/web/index.js';
import type { RecoveryItemView, RecoveryView } from '../src/web/recovery.js';
import type { Card, Provider, Run, RunStatus } from '../src/runtime/types.js';
import { answer, binding } from './helpers.js';

interface Credentials { cookie: string; csrf: string; cookieHeader: string }
interface StateBody { csrf: string; workspace: string; permissions: string[]; serverId: string; startedAt: string }

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(extra: Partial<LocalServerOptions> = {}, provider: Provider = { async complete() { return answer('done'); } }) {
  const root = mkdtempSync(path.join(tmpdir(), 'kodo-web-reconnect-'));
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace);
  const app = new Application(path.join(root, 'data'), provider);
  const card: Card = { id: 'test/reconnect', version: '1.0.0', name: 'Reconnect test', digest: 'reconnect-test', prompt: 'Complete the task.', tools: [] };
  const options: LocalServerOptions = { workspace, binding, permissions: ['read'], card, ...extra };
  let server = await createLocalServer(app, options);
  cleanups.push(async () => { await server.close(); await app.shutdown(); rmSync(root, { recursive: true, force: true }); });
  const authenticate = async (handle: LocalServerHandle = server): Promise<Credentials> => {
    const response = await fetch(handle.origin + '/api/auth', { method: 'POST', headers: { Origin: handle.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: handle.startupSecret }) });
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const body = await response.json() as { csrf: string };
    return { cookie, csrf: body.csrf, cookieHeader: response.headers.get('set-cookie')! };
  };
  let credentials = await authenticate();
  const headers = (extraHeaders: Record<string, string> = {}): Record<string, string> => ({ Cookie: credentials.cookie, Origin: server.origin, 'Content-Type': 'application/json', 'X-Kodo-CSRF': credentials.csrf, ...extraHeaders });
  const get = (url: string): Promise<Response> => fetch(server.origin + url, { headers: headers() });
  const post = (url: string, body: unknown, key = 'request_12345678', override: Record<string, string> = {}): Promise<Response> => fetch(server.origin + url, { method: 'POST', headers: headers({ 'Idempotency-Key': key, ...override }), body: JSON.stringify(body) });
  return {
    app, root, workspace, card, options, headers, get, post,
    get server(): LocalServerHandle { return server; },
    get credentials(): Credentials { return credentials; },
    createRun(objective: string): Run { return app.createRun({ objective, workspace, binding, permissions: ['read'], card }); },
    async state(): Promise<StateBody> { return await (await get('/api/state')).json() as StateBody; },
    async recovery(query = ''): Promise<RecoveryView> {
      const response = await get('/api/recovery' + query);
      expect(response.status).toBe(200);
      return await response.json() as RecoveryView;
    },
    async restart(): Promise<void> { await server.close(); server = await createLocalServer(app, options); credentials = await authenticate(); },
  };
}

/** Persist a deterministic last-event time so ordering is independent of clock resolution. */
function setLastEventTime(app: Application, runId: string, time: string): void {
  const last = app.store.events(runId).at(-1);
  if (!last) throw new Error('run has no events');
  storageTestConnection(app.store).prepare('UPDATE events SET time=? WHERE seq=?').run(time, last.seq);
}

function mark(app: Application, runId: string, status: RunStatus, error?: string): void {
  app.store.updateRun(runId, error === undefined ? { status } : { status, error });
}

describe('web reconnect and recovery', () => {
  it('exposes a stable serverId and startedAt that change when the local server restarts', async () => {
    const web = await setup();
    const first = await web.state();
    expect(first).toMatchObject({ workspace: web.workspace, permissions: ['read'], csrf: web.credentials.csrf });
    expect(first.serverId).toMatch(/^[a-f0-9]{32}$/);
    expect(Number.isNaN(Date.parse(first.startedAt))).toBe(false);
    const repeated = await web.state();
    expect(repeated.serverId).toBe(first.serverId);
    expect(repeated.startedAt).toBe(first.startedAt);

    const staleCookie = web.credentials.cookie;
    await web.restart();
    const restarted = await web.state();
    expect(restarted.serverId).not.toBe(first.serverId);
    expect(new Date(restarted.startedAt).getTime()).toBeGreaterThanOrEqual(new Date(first.startedAt).getTime());
    // A restart invalidates browser cookies; the UI must re-authenticate instead of silently reconnecting.
    expect((await fetch(web.server.origin + '/api/state', { headers: { Cookie: staleCookie, Origin: web.server.origin } })).status).toBe(401);
    expect((await fetch(web.server.origin + '/api/recovery')).status).toBe(401);
  });

  it('projects one recovery item per run with contract priority, ordering, counts, limits and no bindings', async () => {
    const web = await setup();
    const app = web.app;
    const unknown = web.createRun('未知写入任务');
    mark(app, unknown.id, 'failed', 'UNKNOWN_WRITE: pending inspection');
    const interrupted = web.createRun('中断主任务');
    mark(app, interrupted.id, 'interrupted');
    const child: Run = { ...app.store.run(interrupted.id), id: randomUUID(), parentId: interrupted.id, objective: '中断子任务' };
    app.store.putRun(child);
    const older = web.createRun('较早中断');
    mark(app, older.id, 'interrupted');
    setLastEventTime(app, older.id, '2099-01-01T00:00:01.000Z');
    const newer = web.createRun('较新中断');
    mark(app, newer.id, 'interrupted');
    setLastEventTime(app, newer.id, '2099-01-01T00:00:05.000Z');
    const tieA = web.createRun('同刻中断 A');
    mark(app, tieA.id, 'interrupted');
    setLastEventTime(app, tieA.id, '2099-01-01T00:00:02.000Z');
    const tieB = web.createRun('同刻中断 B');
    mark(app, tieB.id, 'interrupted');
    setLastEventTime(app, tieB.id, '2099-01-01T00:00:02.000Z');
    const commandFailed = web.createRun('命令失败任务');
    mark(app, commandFailed.id, 'completed');
    app.store.event(commandFailed.id, 'web.command_failed', { action: 'resume', code: 'WEB_EXECUTION', message: 'execution failed' });
    const queued = web.createRun('排队任务');
    const failed = web.createRun('普通失败');
    mark(app, failed.id, 'failed', 'BOOM: model request failed');
    const completed = web.createRun('普通完成');
    mark(app, completed.id, 'completed');

    const state = await web.state();
    const view = await web.recovery();
    expect(view.serverId).toBe(state.serverId);
    expect(view.startedAt).toBe(state.startedAt);
    expect(Number.isNaN(Date.parse(view.generatedAt))).toBe(false);
    expect(view.counts).toEqual({ verify_write: 1, resume: 6, command_failed: 1, queued: 1 });

    // One item per run; ordinary failures/completions and a run whose latest event is not web.command_failed stay out.
    const ids = view.items.map(item => item.runId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(9);
    expect(ids).not.toContain(failed.id);
    expect(ids).not.toContain(completed.id);
    expect(view.items.map(item => item.kind)).toEqual([
      'verify_write',
      'resume', 'resume', 'resume', 'resume', 'resume', 'resume',
      'command_failed',
      'queued',
    ]);
    const resumes = view.items.filter(item => item.kind === 'resume').map(item => item.runId);
    expect(resumes.slice(0, 4)).toEqual([newer.id, ...[tieA.id, tieB.id].sort(), older.id]);
    expect(resumes.slice(4).sort()).toEqual([interrupted.id, child.id].sort());

    const unknownItem = view.items[0] as RecoveryItemView;
    expect(unknownItem).toMatchObject({ runId: unknown.id, sessionId: app.store.run(unknown.id).sessionId, role: 'main', objective: '未知写入任务', status: 'failed', kind: 'verify_write', error: 'UNKNOWN_WRITE: pending inspection' });
    expect(Object.keys(unknownItem).sort()).toEqual(['createdAt', 'error', 'kind', 'lastEventAt', 'objective', 'role', 'runId', 'sessionId', 'status']);
    const childItem = view.items.find(item => item.runId === child.id) as RecoveryItemView;
    expect(childItem).toMatchObject({ parentId: interrupted.id, role: 'child', objective: '中断子任务' });
    const commandItem = view.items.find(item => item.runId === commandFailed.id) as RecoveryItemView;
    expect(commandItem).toMatchObject({ status: 'completed', kind: 'command_failed', error: null });
    expect(view.items.at(-1)).toMatchObject({ runId: queued.id, kind: 'queued', status: 'queued' });

    // Readiness evidence never carries host bindings or result payloads.
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('"binding"');
    expect(serialized).not.toContain('apiKeyEnv');
    expect(serialized).not.toContain('KODO_TEST_KEY');
    expect(serialized).not.toContain('resultRef');

    // Repeated reads are deterministic, and the limit only truncates items after counts are computed.
    const again = await web.recovery();
    expect(again.items.map(item => item.runId)).toEqual(ids);
    const limited = await web.recovery('?limit=2');
    expect(limited.items.map(item => item.kind)).toEqual(['verify_write', 'resume']);
    expect(limited.counts).toEqual(view.counts);
    expect((await web.recovery('?limit=0')).items).toHaveLength(1);
    expect((await web.recovery('?limit=999')).items).toHaveLength(9);
    expect((await web.get('/api/recovery?limit=abc')).status).toBe(400);
  });

  it('omits runs from other workspaces and from sessions outside the host allowlist, and requires auth', async () => {
    const web = await setup();
    const allowed = web.createRun('本工作区任务');
    web.app.createRun({ objective: '外部工作区任务', workspace: web.root, binding, permissions: ['read'], card: web.card });
    const view = await web.recovery();
    expect(view.items.map(item => item.runId)).toEqual([allowed.id]);
    expect(view.items[0]).toMatchObject({ role: 'main', kind: 'queued' });
    expect((await fetch(web.server.origin + '/api/recovery')).status).toBe(401);
    const unauth = await fetch(web.server.origin + '/api/recovery', { headers: { Cookie: 'kodo_session=forged', Origin: web.server.origin } });
    expect(unauth.status).toBe(401);

    const restrictive = await setup({ sessionIds: [] });
    const hidden = restrictive.createRun('不在允许列表的会话');
    const created = await restrictive.post('/api/runs', { objective: '通过 Web 创建的会话' }, 'allowlist_run_0001');
    expect(created.status).toBe(202);
    const receipt = await created.json() as { runId: string; sessionId: string };
    // The HTTP-created session joins the allowlist; finish its async drive before projecting durable state.
    await vi.waitFor(() => { expect(restrictive.app.store.run(receipt.runId).status).toBe('completed'); });
    mark(restrictive.app, receipt.runId, 'interrupted');
    const filtered = await restrictive.recovery();
    expect(filtered.items.map(item => item.runId)).toEqual([receipt.runId]);
    expect(filtered.items[0]).toMatchObject({ sessionId: receipt.sessionId, kind: 'resume' });
    expect(filtered.items.some(item => item.runId === hidden.id)).toBe(false);
  });

  it('keeps persisted recovery items readable after a restart with a new server identity', async () => {
    const web = await setup();
    const interrupted = web.createRun('重启后待恢复');
    mark(web.app, interrupted.id, 'interrupted');
    const unknown = web.createRun('重启后待核实');
    mark(web.app, unknown.id, 'failed', 'UNKNOWN_WRITE: inspect evidence');
    const queued = web.createRun('重启后等待续接');
    const before = await web.recovery();
    expect(before.items.map(item => [item.runId, item.kind])).toEqual([
      [unknown.id, 'verify_write'],
      [interrupted.id, 'resume'],
      [queued.id, 'queued'],
    ]);
    expect(before.serverId).toBe((await web.state()).serverId);

    await web.restart();
    const after = await web.recovery();
    expect(after.serverId).not.toBe(before.serverId);
    expect(after.serverId).toBe((await web.state()).serverId);
    expect(after.startedAt).toBe((await web.state()).startedAt);
    expect(after.items.map(item => [item.runId, item.kind])).toEqual([
      [unknown.id, 'verify_write'],
      [interrupted.id, 'resume'],
      [queued.id, 'queued'],
    ]);
    expect(after.items.map(item => item.lastEventAt)).toEqual(before.items.map(item => item.lastEventAt));
  });
});

describe('web capability-package host wiring', () => {
  it('keeps package routes disabled, returning an empty overview, unless the host opts in', async () => {
    const web = await setup();
    const overview = await web.get('/api/packages');
    expect(overview.status).toBe(200);
    expect(await overview.json()).toEqual({ enabled: false, actions: { prepare: false, adopt: false }, runtime: null, packages: [], running: [], prepareJobs: [], errors: [] });
    expect((await web.get('/api/packages/jobs/missing-job')).status).toBe(404);
    // Disabled package commands are 404 before the generic Idempotency-Key requirement.
    expect((await web.post('/api/packages/test/missing/1.0.0/prepare', {}, 'package_disabled_1')).status).toBe(404);
    expect((await web.post('/api/packages/test/missing/adopt', { version: '1.0.0' }, 'package_disabled_2')).status).toBe(404);
    expect((await web.post('/api/packages/test/missing/rollback', {}, 'package_disabled_3')).status).toBe(404);
    expect((await web.post('/api/packages/test/missing/rollback', {}, 'package_disabled_4', { 'X-Kodo-CSRF': '' })).status).toBe(403);
    const notOptedIn = await setup({ packages: { enabled: false } });
    expect(await (await notOptedIn.get('/api/packages')).json()).toMatchObject({ enabled: false });
    expect((await notOptedIn.post('/api/packages/test/missing/rollback', {}, 'package_disabled_5')).status).toBe(404);
  });

  it('serves the enabled panel and maps package identity and not-found errors', async () => {
    const web = await setup({ packages: { enabled: true, prepare: true, adopt: true } });
    const overview = await web.get('/api/packages');
    expect(overview.status).toBe(200);
    const body = await overview.json() as { enabled: boolean; actions: { prepare: boolean; adopt: boolean }; packages: unknown[]; runtime: unknown; errors: string[] };
    expect(body).toMatchObject({ enabled: true, actions: { prepare: true, adopt: true }, runtime: null, packages: [], errors: [] });
    expect(JSON.stringify(body)).not.toContain(web.app.store.directory);
    expect((await web.get('/api/packages/jobs/missing-job')).status).toBe(404);
    // Invalid identity (400), not-installed version (404) and business errors (400) keep their contract mapping.
    const invalid = await web.post('/api/packages/INVALID/identity/1.0.0/prepare', {}, 'package_invalid_1');
    expect(invalid.status).toBe(400);
    expect((await invalid.json() as { error: { code: string } }).error.code).toBe('ARGUMENTS');
    const missing = await web.post('/api/packages/test/missing/1.0.0/prepare', {}, 'package_missing_1');
    expect(missing.status).toBe(404);
    expect((await missing.json() as { error: { code: string } }).error.code).toBe('PACKAGE_NOT_FOUND');
    // The workbench may encode `author/name` as one segment; both path forms address the same package.
    const encodedMissing = await web.post('/api/packages/' + encodeURIComponent('test/missing') + '/1.0.0/prepare', {}, 'package_missing_encoded');
    expect(encodedMissing.status).toBe(404);
    expect((await encodedMissing.json() as { error: { code: string } }).error.code).toBe('PACKAGE_NOT_FOUND');
    expect((await web.post('/api/packages/test/missing/1.0.0/prepare', {}, 'package_missing_2', { 'X-Kodo-CSRF': '' })).status).toBe(403);
    const adoptMissing = await web.post('/api/packages/test/missing/adopt', { version: '1.0.0' }, 'package_missing_3');
    expect(adoptMissing.status).toBe(404);
    expect((await adoptMissing.json() as { error: { code: string } }).error.code).toBe('PACKAGE_NOT_FOUND');
    expect((await web.post('/api/packages/' + encodeURIComponent('test/missing') + '/adopt', { version: '1.0.0' }, 'package_missing_encoded_2')).status).toBe(404);
    expect((await web.post('/api/packages/test/missing/adopt', { version: '1.0' }, 'package_missing_4')).status).toBe(400);
    // A package that is not installed is 404 PACKAGE_NOT_FOUND on rollback too; a business error on an
    // installed package (no previously adopted version) stays 400 in the package module.
    const rollbackMissing = await web.post('/api/packages/test/missing/rollback', {}, 'package_missing_5');
    expect(rollbackMissing.status).toBe(404);
    expect((await rollbackMissing.json() as { error: { code: string } }).error.code).toBe('PACKAGE_NOT_FOUND');

    const readOnly = await setup({ packages: { enabled: true } });
    expect(await (await readOnly.get('/api/packages')).json()).toMatchObject({ enabled: true, actions: { prepare: false, adopt: false } });
    expect((await readOnly.post('/api/packages/test/missing/1.0.0/prepare', {}, 'package_readonly_1')).status).toBe(404);
    expect((await readOnly.post('/api/packages/test/missing/adopt', { version: '1.0.0' }, 'package_readonly_2')).status).toBe(404);
  });

  it('rejects invalid package host options before the local server listens', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'kodo-web-package-options-'));
    const workspace = path.join(root, 'workspace');
    mkdirSync(workspace);
    const app = new Application(path.join(root, 'data'), { async complete() { return answer('done'); } });
    cleanups.push(async () => { await app.shutdown(); rmSync(root, { recursive: true, force: true }); });
    const card: Card = { id: 'test/reconnect', version: '1.0.0', name: 'Reconnect test', digest: 'reconnect-test', prompt: 'Complete the task.', tools: [] };
    const base: LocalServerOptions = { workspace, binding, permissions: ['read'], card };
    const registry = path.join(root, 'capabilities');
    await expect(createLocalServer(app, { ...base, packages: { enabled: true, registry: 'relative/dir' } })).rejects.toMatchObject({ code: 'PACKAGE_REGISTRY' });
    await expect(createLocalServer(app, { ...base, packages: { enabled: true, registry, runtime: { id: 'invalid', version: '1.0.0', digest: 'a'.repeat(64) } } })).rejects.toMatchObject({ code: 'PACKAGE_RUNTIME' });
    await expect(createLocalServer(app, { ...base, packages: { enabled: true, registry, runtime: { id: 'test/pkg', version: 'v1', digest: 'a'.repeat(64) } } })).rejects.toMatchObject({ code: 'PACKAGE_RUNTIME' });
    await expect(createLocalServer(app, { ...base, packages: { enabled: true, registry, npmCli: 'npm' } })).rejects.toMatchObject({ code: 'PACKAGE_NPM_CLI' });
  });
});
