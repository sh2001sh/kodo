import { storageTestConnection } from '../src/storage/test-access.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { createLocalServer } from '../src/web/server.js';
import type { LocalServerHandle, LocalServerOptions } from '../src/web/server.js';
import type { Card, Provider, Run } from '../src/runtime/types.js';
import { answer, binding } from './helpers.js';

interface Credentials { cookie: string; csrf: string; cookieHeader: string }
type CompletionRequest = Parameters<Provider['complete']>[0];
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const offline = (): Provider => ({ async complete() { return answer('offline child completed'); } });

async function setup(provider: Provider) {
  const root = mkdtempSync(path.join(tmpdir(), 'kodo-web-collab-'));
  const workspace = path.join(root, 'workspace');
  mkdirSync(workspace);
  const app = new Application(path.join(root, 'data'), provider, undefined, { agentFactors: { D: false, E: false, B: false } });
  const card: Card = { id: 'test/web-collab', version: '1.0.0', name: 'Web collaboration test', digest: 'web-collab-test', prompt: 'Complete the task.', tools: [] };
  const options: LocalServerOptions = { workspace, binding, permissions: ['read'], card };
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
    app,
    get server(): LocalServerHandle { return server; },
    get credentials(): Credentials { return credentials; },
    headers, get, post,
    createMain(objective = 'main task'): Run { return app.createRun({ objective, workspace, binding, permissions: ['read'], card }); },
    async restart(): Promise<void> { await server.close(); server = await createLocalServer(app, options); credentials = await authenticate(); },
  };
}
function spawnChild(app: Application, mainId: string, objective = 'child task'): Run {
  const mailbox = app.coordinator.mailbox;
  const main = app.store.run(mainId);
  return app.store.run((mailbox.execute(main, `spawn:${objective}`, 'spawn_agent', mailbox.validate(main, 'spawn_agent', JSON.stringify({ objective }))) as { id: string }).id);
}
describe('web collaboration endpoints', () => {
  it('serves the read-only collaboration view without host bindings', async () => {
    const web = await setup(offline());
    const main = web.createMain('collaboration main task');
    const child = spawnChild(web.app, main.id, 'inspect project structure');
    const response = await web.get(`/api/runs/${main.id}/collaboration`);
    expect(response.status).toBe(200);
    const view = await response.json() as Record<string, unknown>;
    expect(view).toMatchObject({ sessionId: main.sessionId, anchorRunId: main.id });
    expect((view.agents as { id: string }[]).map(agent => agent.id)).toEqual([main.id, child.id]);
    expect(view.children).toMatchObject({ maximum: null, maximumActive: 8, created: 1, active: 1, remainingActive: 7 });
    expect(Array.isArray(view.pending)).toBe(true);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('apiKeyEnv');
    expect(serialized).not.toContain('KODO_TEST_KEY');
    expect((await fetch(web.server.origin + `/api/runs/${main.id}/collaboration`)).status).toBe(401);
    expect((await web.get('/api/runs/not-a-run/collaboration')).status).toBe(404);
  });

  it('spawns a fresh child through the authenticated endpoint and re-drives it after restart', async () => {
    const requests: CompletionRequest[] = [];
    const web = await setup({ async complete(request) { requests.push(request); return answer('child completed after restart'); } });
    const main = web.createMain('coordinate one child');
    const response = await web.post(`/api/runs/${main.id}/agents/spawn`, { objective: 'inspect the project' }, 'agent_spawn_0001');
    expect(response.status).toBe(202);
    const receipt = await response.json() as { requestId: string; runId: string; sessionId: string; agentRunId: string; status: string };
    expect(receipt).toMatchObject({ requestId: 'agent_spawn_0001', runId: main.id, sessionId: main.sessionId, status: 'accepted' });
    const child = web.app.store.run(receipt.agentRunId);
    expect(child).toMatchObject({ parentId: main.id, card: { digest: main.card.digest } });
    await vi.waitFor(() => { expect(web.app.store.run(child.id).status).toBe('completed'); });

    // Simulate a durable spawn receipt whose async drive never ran before the process exited.
    const replayTarget = spawnChild(web.app, main.id, 'replay after restart');
    const fingerprint = 'restart-spawn-fingerprint';
    storageTestConnection(web.app.store).prepare('INSERT INTO web_requests VALUES (?,?,?,?,?,?)').run('restart_agent_spawn_01', fingerprint,
      JSON.stringify({ requestId: 'restart_agent_spawn_01', runId: main.id, sessionId: main.sessionId, agentRunId: replayTarget.id, status: 'accepted' }),
      'agent_spawn', main.id, new Date().toISOString());
    await web.restart();
    await vi.waitFor(() => { expect(web.app.store.run(replayTarget.id).status).toBe('completed'); });
    expect(requests.length).toBeGreaterThanOrEqual(2);
  });

  it('cancels only the addressed child idempotently and keeps host policy on the main run', async () => {
    const web = await setup(offline());
    const main = web.createMain('cancel targets');
    const child = spawnChild(web.app, main.id, 'long child');
    const cancelled = await web.post(`/api/runs/${main.id}/agents/${child.id}/cancel`, {}, 'agent_cancel_0001');
    expect(cancelled.status).toBe(202);
    expect(await cancelled.json()).toMatchObject({ agentRunId: child.id, status: expect.stringMatching(/cancelled|queued|running/u) });
    await vi.waitFor(() => { expect(web.app.store.run(child.id).status).toBe('cancelled'); });
    const replay = await web.post(`/api/runs/${main.id}/agents/${child.id}/cancel`, {}, 'agent_cancel_0001');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ requestId: 'agent_cancel_0001' });
  });

  it('rejects removed directed-child input and unauthenticated collaboration writes', async () => {
    const web = await setup(offline());
    const main = web.createMain('reject removed routes');
    const child = spawnChild(web.app, main.id, 'unchanged child');
    const removed = await web.post(`/api/runs/${main.id}/agents/${child.id}/input`, { content: 'old route' }, 'agent_input_0001');
    expect(removed.status).toBe(404);
    const unauthenticated = await fetch(web.server.origin + `/api/runs/${main.id}/agents/${child.id}/cancel`, { method: 'POST', headers: { Origin: web.server.origin, 'Content-Type': 'application/json', 'Idempotency-Key': 'agent_cancel_0002' }, body: '{}' });
    expect(unauthenticated.status).toBe(401);
  });
});
