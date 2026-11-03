import { storageTestConnection } from '../src/storage/test-access.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { createLocalServer } from '../src/web/index.js';
import type { LocalServerHandle, LocalServerOptions } from '../src/web/index.js';
import type { Card, Provider, Run, Wait } from '../src/runtime/types.js';
import { answer, binding } from './helpers.js';

type CompletionRequest = Parameters<Provider['complete']>[0];
interface Credentials { cookie: string; csrf: string; cookieHeader: string }
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const offline = (): Provider => ({ async complete() { throw new Error('unexpected model request'); } });

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
    app, root, workspace, card, options,
    get server(): LocalServerHandle { return server; },
    get credentials(): Credentials { return credentials; },
    headers, get, post,
    createMain(objective = 'main task'): Run { return app.createRun({ objective, workspace, binding, permissions: ['read'], card }); },
    async restart(): Promise<void> { await server.close(); server = await createLocalServer(app, options); credentials = await authenticate(); },
  };
}
/** Create a real direct child through the collaboration mailbox (no model call). */
function spawnChild(app: Application, mainId: string, objective = 'child task'): Run {
  const mailbox = app.coordinator.mailbox;
  const main = app.store.run(mainId);
  const args = mailbox.validate(main, 'spawn_agent', JSON.stringify({ objective }));
  const result = mailbox.execute(main, `spawn:${objective}`, 'spawn_agent', args) as { id: string };
  return app.store.run(result.id);
}
function askUser(app: Application, runId: string, questionId: string, content: string): void {
  const run = app.store.run(runId);
  app.store.putMessage({ id: questionId, sessionId: run.sessionId, from: run.id, to: 'user', kind: 'question', content });
}
function waitFor(app: Application, runId: string, args: Record<string, unknown>): Wait {
  const mailbox = app.coordinator.mailbox;
  const run = app.store.run(runId);
  const result = mailbox.execute(run, `wait:${runId}`, 'wait_for_events', mailbox.validate(run, 'wait_for_events', JSON.stringify(args))) as { waitId: string };
  const wait = app.store.wait(result.waitId);
  app.store.updateRun(runId, { status: 'waiting' });
  return wait;
}
async function expectError(response: { status: number; json(): Promise<unknown> }, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  const body = await response.json() as { error?: { code?: string; message?: string } };
  expect(body.error?.code).toBe(code);
}
const inbound = (app: Application, runId: string, kinds: readonly string[]): number => app.store.messages(app.store.run(runId).sessionId).filter(message => message.to === runId && kinds.includes(message.kind)).length;

describe('web collaboration endpoints', () => {
  it('serves the read-only collaboration view for a main or child run without host bindings', async () => {
    const web = await setup(offline());
    const main = web.createMain('协作主任务');
    const child = spawnChild(web.app, main.id, '查看项目结构');
    const response = await web.get(`/api/runs/${main.id}/collaboration`);
    expect(response.status).toBe(200);
    const view = await response.json() as Record<string, unknown>;
    expect(view).toMatchObject({ sessionId: main.sessionId, anchorRunId: main.id });
    expect((view.agents as { id: string }[]).map(agent => agent.id)).toEqual([main.id, child.id]);
    expect(view.children).toMatchObject({ maximum: null, maximumActive: 8, created: 1, active: 1, remainingActive: 7 });
    expect(Array.isArray(view.pending)).toBe(true);
    expect(view).not.toHaveProperty('binding');
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('"binding"');
    expect(serialized).not.toContain('apiKeyEnv');
    expect(serialized).not.toContain('KODO_TEST_KEY');
    const childView = await web.get(`/api/runs/${child.id}/collaboration`);
    expect(childView.status).toBe(200);
    expect(await childView.json()).toMatchObject({ anchorRunId: main.id });
    expect((await fetch(web.server.origin + `/api/runs/${main.id}/collaboration`)).status).toBe(401);
    expect((await web.get('/api/runs/not-a-run/collaboration')).status).toBe(404);
  });

  it('writes child input plus a main notice, wakes a waiting child and completes it', async () => {
    const requests: CompletionRequest[] = [];
    const web = await setup({ async complete(request) { requests.push(request); return answer('子任务已按补充要求完成'); } });
    const main = web.createMain('协调验收子任务');
    const child = spawnChild(web.app, main.id, '整理验收证据');
    askUser(web.app, child.id, 'child-question-1', '需要用户确认范围');
    const childWait = waitFor(web.app, child.id, { question_ids: ['child-question-1'], timeout_ms: 300_000 });
    waitFor(web.app, main.id, { run_ids: [child.id], timeout_ms: 300_000 });
    expect(web.app.store.run(child.id).status).toBe('waiting');
    expect(web.app.store.run(main.id).status).toBe('waiting');

    const response = await web.post(`/api/runs/${main.id}/agents/${child.id}/input`, { content: '请补充验收证据' }, 'agent_input_0001');
    expect(response.status).toBe(202);
    const receipt = await response.json() as { requestId: string; runId: string; sessionId: string; agentRunId: string; status: string };
    expect(receipt).toMatchObject({ requestId: 'agent_input_0001', runId: main.id, sessionId: main.sessionId, agentRunId: child.id, status: 'accepted' });

    await vi.waitFor(() => { expect(web.app.store.run(child.id).status).toBe('completed'); });
    // The anchor is driven too: a waiting main resumes after the child settles and sees the notice.
    await vi.waitFor(() => { expect(web.app.store.run(main.id).status).toBe('completed'); });

    const messages = web.app.store.messages(main.sessionId);
    const childInputs = messages.filter(message => message.to === child.id && message.kind === 'input');
    expect(childInputs).toHaveLength(1);
    expect(childInputs[0]).toMatchObject({ from: 'user', content: '请补充验收证据' });
    const notices = messages.filter(message => message.to === main.id && message.kind === 'notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.content).toContain('整理验收证据');
    expect(notices[0]!.content).toContain('请补充验收证据');
    expect(notices[0]!.content).toMatch(/do not issue a conflicting requirement/i);

    expect(web.app.store.events(child.id).filter(event => event.type === 'user.agent_input')).toHaveLength(1);
    expect(web.app.store.events(main.id).filter(event => event.type === 'user.agent_input')).toHaveLength(1);
    expect(web.app.store.session(main.sessionId).decisionVersion ?? 0).toBe(0);
    expect(web.app.store.run(child.id).decisionVersion ?? 0).toBe(0);
    expect(web.app.store.wait(childWait.id).status).toBe('settled');
    expect(requests).toHaveLength(2);
    expect(requests[0]!.messages.some(message => message.role === 'user' && message.content.includes('请补充验收证据'))).toBe(true);

    // The same idempotency key and JSON replay the receipt without writing or driving again.
    const replay = await web.post(`/api/runs/${main.id}/agents/${child.id}/input`, { content: '请补充验收证据' }, 'agent_input_0001');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    expect(inbound(web.app, child.id, ['input'])).toBe(1);
    expect(inbound(web.app, main.id, ['notice'])).toBe(1);
    expect(web.app.store.events(child.id).filter(event => event.type === 'user.agent_input')).toHaveLength(1);
    expect(requests).toHaveLength(2);
    expect((await web.post(`/api/runs/${main.id}/agents/${child.id}/input`, { content: '不同要求' }, 'agent_input_0001')).status).toBe(409);
  });

  it('cancels only the addressed child, idempotently, and still anchors host policy on the main run', async () => {
    const web = await setup(offline());
    const main = web.createMain('取消子任务主任务');
    const target = spawnChild(web.app, main.id, '被取消的子任务');
    const other = spawnChild(web.app, main.id, '保留的子任务');
    const response = await web.post(`/api/runs/${main.id}/agents/${target.id}/cancel`, {}, 'agent_cancel_0001');
    expect(response.status).toBe(202);
    const receipt = await response.json() as { requestId: string; runId: string; sessionId: string; agentRunId: string; status: string };
    expect(receipt).toMatchObject({ requestId: 'agent_cancel_0001', runId: main.id, sessionId: main.sessionId, agentRunId: target.id, status: 'cancelled' });
    expect(web.app.store.run(target.id).status).toBe('cancelled');
    expect(web.app.store.run(other.id).status).toBe('queued');
    expect(web.app.store.run(main.id).status).toBe('queued');

    const replay = await web.post(`/api/runs/${main.id}/agents/${target.id}/cancel`, {}, 'agent_cancel_0001');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    const again = await web.post(`/api/runs/${main.id}/agents/${target.id}/cancel`, {}, 'agent_cancel_0002');
    expect(again.status).toBe(202);
    expect(await again.json()).toMatchObject({ runId: main.id, agentRunId: target.id, status: 'cancelled' });
    expect(web.app.store.events(target.id).filter(event => event.type === 'run.cancelled')).toHaveLength(1);
    expect(web.app.store.run(other.id).status).toBe('queued');

    expect((await web.post(`/api/runs/${main.id}/agents/${main.id}/cancel`, {}, 'agent_cancel_0003')).status).toBe(400);
    const privileged = web.app.createRun({ objective: 'privileged anchor', workspace: web.workspace, binding, card: web.card, permissions: ['read', 'exec'] });
    const privilegedChild = spawnChild(web.app, privileged.id, 'privileged child');
    expect((await web.post(`/api/runs/${privileged.id}/agents/${privilegedChild.id}/cancel`, {}, 'agent_cancel_0004')).status).toBe(403);
    expect(web.app.store.run(target.id).status).toBe('cancelled');
  });

  it('rejects invalid, cross-session, indirect, ended and unauthenticated targets without writing', async () => {
    const web = await setup(offline());
    const main = web.createMain('拒绝非法目标主任务');
    const otherMain = web.app.createRun({ objective: '另一个会话', workspace: web.workspace, binding, card: web.card, permissions: ['read'] });
    const otherChild = spawnChild(web.app, otherMain.id, '其他会话的子任务');
    const child = spawnChild(web.app, main.id, '直接子任务');
    const grandchild: Run = { ...child, id: 'grandchild-target', parentId: child.id, objective: '孙任务' };
    web.app.store.putRun(grandchild);
    const route = (anchor: string, agent: string): string => `/api/runs/${anchor}/agents/${agent}/input`;
    const writes = (): number => inbound(web.app, child.id, ['input', 'notice']) + inbound(web.app, main.id, ['input', 'notice']);

    await expectError(await web.post(route(main.id, grandchild.id), { content: '越级' }, 'agent_reject_0001'), 400, 'AGENT_TARGET');
    await expectError(await web.post(route(main.id, otherChild.id), { content: '跨会话' }, 'agent_reject_0002'), 400, 'SESSION_DENIED');
    await expectError(await web.post(route(main.id, 'not-a-run'), { content: '不存在' }, 'agent_reject_0003'), 404, 'NOT_FOUND');
    await expectError(await web.post(route(child.id, grandchild.id), { content: '锚点错误' }, 'agent_reject_0004'), 400, 'MAIN_RUN');
    await expectError(await web.post(route(main.id, main.id), { content: '目标是主任务' }, 'agent_reject_0005'), 400, 'AGENT_TARGET');
    await expectError(await web.post(route(main.id, child.id), { content: '空令牌' }, 'agent_reject_0006', { 'X-Kodo-CSRF': '' }), 403, 'CSRF');
    await expectError(await web.post(route(main.id, child.id), { content: '错误令牌' }, 'agent_reject_0007', { 'X-Kodo-CSRF': 'wrong-token' }), 403, 'CSRF');
    const missingOrigin = await fetch(web.server.origin + route(main.id, child.id), { method: 'POST', headers: { Cookie: web.credentials.cookie, 'Content-Type': 'application/json', 'X-Kodo-CSRF': web.credentials.csrf, 'Idempotency-Key': 'agent_reject_0008' }, body: JSON.stringify({ content: '缺少来源' }) });
    expect(missingOrigin.status).toBe(403);
    expect(writes()).toBe(0);

    const ended = spawnChild(web.app, main.id, '已结束的子任务');
    web.app.store.updateRun(ended.id, { status: 'completed' });
    await expectError(await web.post(route(main.id, ended.id), { content: '太晚了' }, 'agent_reject_0009'), 400, 'RUN_ENDED');
    expect(writes()).toBe(0);
  });

  it('re-drives a queued child from a persisted agent_input receipt after restart and never replays agent_cancel', async () => {
    const requests: CompletionRequest[] = [];
    const web = await setup({ async complete(request) { requests.push(request); return answer('重启续接完成'); } });
    const app = web.app;
    const main = web.createMain('重启续接主任务');
    const resumed = spawnChild(app, main.id, '重启后继续的子任务');
    const cancelled = spawnChild(app, main.id, '不应被重放的取消目标');
    const blocker = spawnChild(app, main.id, '继续阻塞主任务的子任务');
    askUser(app, resumed.id, 'resume-question-1', '等待用户补充');
    waitFor(app, resumed.id, { question_ids: ['resume-question-1'], timeout_ms: 300_000 });
    askUser(app, cancelled.id, 'cancel-question-1', '等待用户决定');
    waitFor(app, cancelled.id, { question_ids: ['cancel-question-1'], timeout_ms: 300_000 });
    askUser(app, blocker.id, 'blocker-question-1', '主任务仍需等待');
    waitFor(app, blocker.id, { question_ids: ['blocker-question-1'], timeout_ms: 300_000 });
    waitFor(app, main.id, { run_ids: [resumed.id, blocker.id], mode: 'all', timeout_ms: 300_000 });

    // Simulate an accepted request whose async drive never ran before the process exited:
    // the kernel transaction and the HTTP receipt are already durable.
    const written = app.submitAgentInput(main.id, resumed.id, '继续补充');
    expect(written.agent.status).toBe('queued');
    const fingerprint = createHash('sha256').update(JSON.stringify({ route: `/api/runs/${main.id}/agents/${resumed.id}/input`, body: { content: '继续补充' } })).digest('hex');
    const createdAt = new Date().toISOString();
    storageTestConnection(app.store).prepare('INSERT INTO web_requests VALUES (?,?,?,?,?,?)').run('restart_agent_input_01', fingerprint, JSON.stringify({ requestId: 'restart_agent_input_01', runId: main.id, sessionId: main.sessionId, agentRunId: resumed.id, status: 'accepted' }), 'agent_input', main.id, createdAt);
    storageTestConnection(app.store).prepare('INSERT INTO web_requests VALUES (?,?,?,?,?,?)').run('restart_agent_cancel_01', 'cancel-receipt-fingerprint', JSON.stringify({ requestId: 'restart_agent_cancel_01', runId: main.id, sessionId: main.sessionId, agentRunId: cancelled.id, status: 'cancelled' }), 'agent_cancel', main.id, createdAt);

    await web.restart();
    await vi.waitFor(() => { expect(app.store.run(resumed.id).status).toBe('completed'); });
    // The anchor is driven but stays waiting on an independent blocker; the cancel receipt is not replayed.
    expect(app.store.run(main.id).status).toBe('waiting');
    expect(app.store.run(cancelled.id).status).toBe('waiting');
    expect(app.store.events(resumed.id).filter(event => event.type === 'web.command_failed')).toHaveLength(0);
    expect(app.store.events(cancelled.id).filter(event => event.type === 'web.command_failed')).toHaveLength(0);
    expect(requests).toHaveLength(1);

    // The durable receipt still replays after the restart without writing another input.
    const replay = await web.post(`/api/runs/${main.id}/agents/${resumed.id}/input`, { content: '继续补充' }, 'restart_agent_input_01');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ requestId: 'restart_agent_input_01', runId: main.id, agentRunId: resumed.id, status: 'accepted' });
    expect(inbound(app, resumed.id, ['input'])).toBe(1);
    expect(requests).toHaveLength(1);
  });
});
