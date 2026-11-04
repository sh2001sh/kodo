import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { Application } from '../src/application/index.js';
import { createLocalServer } from '../src/web/index.js';
import type { LocalServerHandle, LocalServerOptions } from '../src/web/index.js';
import { workbenchHtml, workbenchScript } from '../src/web/workbench.js';
import { answer, binding } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup(extra: Partial<LocalServerOptions> = {}, exploration?: boolean) {
  const root = mkdtempSync(path.join(tmpdir(), 'kodo-web-')); const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
  const app = new Application(path.join(root, 'data'), { async complete() { return answer('结果 <script>alert(1)</script>'); } }, undefined, { exploration });
  const options: LocalServerOptions = { workspace, binding, permissions: ['read'], card: { id: 'test/web', version: '1.0.0', name: 'Web test', digest: 'web-test', prompt: 'Complete the task.', tools: [] }, ...extra };
  let server = await createLocalServer(app, options);
  cleanups.push(async () => { await server.close(); await app.shutdown(); rmSync(root, { recursive: true, force: true }); });
  async function auth(handle: LocalServerHandle = server) {
    const response = await fetch(handle.origin + '/api/auth', { method: 'POST', headers: { Origin: handle.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: handle.startupSecret }) });
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!; const body = await response.json() as { csrf: string };
    return { cookie, csrf: body.csrf, cookieHeader: response.headers.get('set-cookie')! };
  }
  const credentials = await auth();
  function headers(extraHeaders: Record<string, string> = {}) { return { Cookie: credentials.cookie, Origin: server.origin, 'Content-Type': 'application/json', 'X-Kodo-CSRF': credentials.csrf, ...extraHeaders }; }
  const get = (url: string) => fetch(server.origin + url, { headers: headers() });
  const post = (url: string, body: unknown, key = 'request_12345678', override: Record<string, string> = {}) => fetch(server.origin + url, { method: 'POST', headers: headers({ 'Idempotency-Key': key, ...override }), body: JSON.stringify(body) });
  return { app, root, workspace, options, credentials, get, post, auth, headers, get server() { return server; }, async restart() { await server.close(); server = await createLocalServer(app, options); Object.assign(credentials, await auth()); } };
}

describe('loopback web workbench', () => {
  it('exchanges the startup secret once and requires an authenticated strict cookie', async () => {
    const web = await setup();
    expect(web.credentials.cookieHeader).toContain('HttpOnly'); expect(web.credentials.cookieHeader).toContain('SameSite=Strict');
    const unauth = await fetch(web.server.origin + '/api/runs'); expect(unauth.status).toBe(401);
    const reused = await fetch(web.server.origin + '/api/auth', { method: 'POST', headers: { Origin: web.server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: web.server.startupSecret }) });
    expect(reused.status).toBe(401);
    const state = await web.get('/api/state'); expect(state.status).toBe(200); expect(await state.json()).toMatchObject({ permissions: ['read'], workspace: web.workspace });
    await web.restart();
    const response = await fetch(web.server.origin + '/api/auth', { method: 'POST', headers: { Origin: web.server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: 'x' }) });
    expect(response.status).toBe(401);
  });
  it('rejects untrusted Host, cross-origin requests, missing Origin and CSRF', async () => {
    const web = await setup();
    expect((await web.post('/api/runs', { objective: 'bad' }, 'csrf_failure', { 'X-Kodo-CSRF': '' })).status).toBe(403);
    expect((await web.post('/api/runs', { objective: 'bad' }, 'origin_failure', { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(web.server.origin + '/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(403);
    const hostStatus = await new Promise<number>(resolve => { const req = request(web.server.origin + '/api/state', { headers: { ...web.headers(), Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode!); }); req.end(); });
    expect(hostStatus).toBe(403);
    expect((await fetch(web.server.origin + '/api/state', { headers: { ...web.headers(), Origin: 'null' } })).status).toBe(403);
    expect(web.app.runs().items).toHaveLength(0);
  });
  it('creates, executes and accepts a follow-up, with durable mutation deduplication', async () => {
    const web = await setup();
    const first = await web.post('/api/runs', { objective: '完成任务' }); expect(first.status).toBe(202);
    const receipt = await first.json() as { runId: string };
    await web.app.run(receipt.runId);
    expect((await (await web.get('/api/runs/' + receipt.runId + '/snapshot')).json()).run.status).toBe('completed');
    const repeated = await web.post('/api/runs', { objective: '完成任务' }); expect(await repeated.json()).toMatchObject({ runId: receipt.runId });
    expect(web.app.runs().items).toHaveLength(1);
    expect((await web.post('/api/runs', { objective: '更改任务' })).status).toBe(409);
    await web.restart();
    expect((await web.post('/api/runs', { objective: '完成任务' })).status).toBe(200); expect(web.app.runs().items).toHaveLength(1);
    const next = await web.post('/api/runs/' + receipt.runId + '/input', { content: '继续检查' }, 'follow_up_1234'); expect(next.status).toBe(202);
    const continuation = await next.json() as { runId: string }; expect(continuation.runId).not.toBe(receipt.runId);
    expect(web.app.store.run(continuation.runId).continuationOf).toBe(receipt.runId);
    await web.app.run(continuation.runId);
  });
  it.each([
    { exploration: undefined },
    { exploration: false },
  ])('executes and continues the application default card through HTTP (%j)', async ({ exploration }) => {
    const web = await setup({ card: undefined }, exploration);
    const created = await web.post('/api/runs', { objective: 'Use the default agent' });
    expect(created.status).toBe(202);
    const { runId } = await created.json() as { runId: string };
    const run = web.app.store.run(runId);
    expect(run.card.digest).toBe(web.app.defaultCard.digest);
    expect(run.card.tools.includes('knowledge.read')).toBe(false);
    await vi.waitFor(() => { expect(web.app.store.run(runId).status).toBe('completed'); });
    await web.restart();
    const continued = await web.post('/api/runs/' + runId + '/input', { content: 'Continue the default agent' }, 'default_followup_123');
    expect(continued.status).toBe(202);
    const next = await continued.json() as { runId: string };
    expect(web.app.store.run(next.runId).card.digest).toBe(run.card.digest);
    await vi.waitFor(() => { expect(web.app.store.run(next.runId).status).toBe('completed'); });
    const foreign = web.app.createRun({ objective: 'Different host contract', workspace: web.workspace, binding, card: { ...run.card, id: 'test/foreign', digest: 'foreign-card' } });
    expect((await web.post('/api/runs/' + foreign.id + '/cancel', {}, 'foreign_cancel_123')).status).toBe(403);
  });
  it('pins host capabilities and denies other workspaces and artifacts by identity', async () => {
    const web = await setup();
    expect((await web.post('/api/runs', { objective: 'run', permissions: ['exec'], workspace: web.root })).status).toBe(400);
    const foreign = web.app.createRun({ objective: 'foreign', workspace: web.root, binding, card: web.options.card });
    const artifact = web.app.store.artifact(foreign.id, web.app.store.blob({ content: 'private' }));
    expect((await web.get('/api/runs/' + foreign.id + '/snapshot')).status).toBe(404);
    const local = web.app.createRun({ objective: 'local', workspace: web.workspace, binding, card: web.options.card });
    expect((await web.get('/api/runs/' + local.id + '/artifacts/' + artifact)).status).toBe(404);
    // The deleted session method catalog has no read or publication endpoint.
    expect((await web.get('/api/runs/' + local.id + '/methods')).status).toBe(404);
    expect((await web.post('/api/runs/' + local.id + '/methods', { expectedDigest: 'd'.repeat(64) }, 'deleted_methods')).status).toBe(404);
    const privileged = web.app.createRun({ objective: 'privileged', workspace: web.workspace, binding, card: web.options.card, permissions: ['read', 'exec'] });
    expect((await web.post('/api/runs/' + privileged.id + '/cancel', {}, 'no_escalation')).status).toBe(403);
    const list = await (await web.get('/api/runs')).json(); expect(list.items.map((item: { id: string }) => item.id)).not.toContain(foreign.id);
    expect(list.items.some((item: Record<string, unknown>) => 'binding' in item)).toBe(false);
  });
  it('answers pending questions, cancels tasks and rejects invalid resumes', async () => {
    const web = await setup(); const run = web.app.createRun({ objective: 'question', workspace: web.workspace, binding, card: web.options.card });
    web.app.store.putMessage({ id: 'question-test', sessionId: run.sessionId, from: run.id, to: 'user', kind: 'question', content: '选择什么？' });
    const response = await web.post('/api/runs/' + run.id + '/answer', { questionId: 'question-test', content: '第一项' }, 'answer_request'); expect(response.status).toBe(202);
    await web.app.run(run.id); expect(web.app.store.answer('question-test')?.content).toBe('第一项');
    expect((await web.post('/api/runs/' + run.id + '/resume', {}, 'resume_invalid')).status).toBe(409);
    const queued = web.app.createRun({ objective: 'cancel', workspace: web.workspace, binding, card: web.options.card });
    expect((await web.post('/api/runs/' + queued.id + '/cancel', {}, 'cancel_request')).status).toBe(202);
    expect(web.app.store.run(queued.id).status).toBe('cancelled');
    expect((await web.post('/api/runs/' + queued.id + '/answer', { questionId: 'missing', content: 'answer' }, 'missing_question')).status).toBe(404);
  });
  it('keeps child question answers attached to the main conversation and preserves host bindings', async () => {
    const seen: string[] = []; const web = await setup({ onSession: id => { seen.push(id); } });
    const main = web.app.createRun({ objective: 'coordinator', workspace: web.workspace, binding, card: web.options.card });
    const child = { ...main, id: 'child-question-owner', parentId: main.id, objective: 'child question' }; web.app.store.putRun(child);
    web.app.store.putMessage({ id: 'child-question', sessionId: main.sessionId, from: child.id, to: 'user', kind: 'question', content: '子任务需要确认' });
    const response = await web.post('/api/runs/' + main.id + '/answer', { questionId: 'child-question', content: '继续' }, 'answer_child_123');
    expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ runId: main.id });
    await web.app.run(main.id);
    expect(web.app.store.answer('child-question')?.to).toBe(child.id);
    expect(web.app.store.events(main.id).some(event => event.type === 'web.command_failed')).toBe(false);
    expect(seen).toContain(main.sessionId);
  });
  it('replays durable SSE sequence ids after reconnect and releases disconnected streams', async () => {
    const web = await setup(); const run = web.app.createRun({ objective: 'stream', workspace: web.workspace, binding, card: web.options.card });
    const subscribe = web.app.store.subscribe.bind(web.app.store); let activeSubscriptions = 0;
    vi.spyOn(web.app.store, 'subscribe').mockImplementation(listener => { activeSubscriptions++; const unsubscribe = subscribe(listener); return () => { activeSubscriptions--; unsubscribe(); }; });
    web.app.store.event(run.id, 'test.before', { marker: 'persisted' }); const latest = web.app.store.events(run.id).at(-1)!.seq;
    const abort = new AbortController();
    const stream = await fetch(web.server.origin + '/api/runs/' + run.id + '/events?after=0', { headers: { ...web.headers(), 'Last-Event-ID': String(latest - 1) }, signal: abort.signal });
    expect(stream.headers.get('content-type')).toContain('text/event-stream'); const reader = stream.body!.getReader();
    expect(activeSubscriptions).toBe(1);
    const replay = new TextDecoder().decode((await reader.read()).value); expect(replay).toContain('id: ' + latest); expect(replay).toContain('test.before'); expect(replay).not.toContain('run.queued');
    web.app.store.event(run.id, 'test.after', { marker: 'live' });
    const live = new TextDecoder().decode((await reader.read()).value); expect(live).toContain('test.after');
    abort.abort(); await reader.cancel().catch(() => undefined);
    await vi.waitFor(() => { expect(activeSubscriptions).toBe(0); });
    const artifact = web.app.store.artifact(run.id, web.app.store.blob({ content: '<img src=x onerror=alert(1)>' }));
    expect(await (await web.get('/api/runs/' + run.id + '/artifacts/' + artifact)).json()).toMatchObject({ content: '<img src=x onerror=alert(1)>' });
  });
  it('serves restrictive static assets and renders untrusted model content as plain text', async () => {
    const web = await setup(); const page = await fetch(web.server.origin);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'"); expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(workbenchHtml).toContain('type="password"'); expect(workbenchHtml).not.toContain('onclick=');
    expect(workbenchScript).toContain('textContent=text'); expect(workbenchScript).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(workbenchScript).toContain('new EventSource'); expect(workbenchScript).toContain('crypto.randomUUID()');
    expect((await web.post('/api/runs', { objective: '' }, 'empty_objective')).status).toBe(400);
    expect((await web.post('/api/runs', { objective: 'ok' }, 'short')).status).toBe(400);
  });
  it('resumes an interrupted run once and refuses to replay an uncertain write', async () => {
    const web = await setup(); const interrupted = web.app.createRun({ objective: 'resume', workspace: web.workspace, binding, card: web.options.card });
    web.app.store.updateRun(interrupted.id, { status: 'interrupted' });
    const resumed = await web.post('/api/runs/' + interrupted.id + '/resume', {}, 'resume_once_123'); expect(resumed.status).toBe(202);
    await web.app.run(interrupted.id); expect(web.app.store.run(interrupted.id).status).toBe('completed');
    const calls = web.app.store.calls(interrupted.id).length;
    expect((await web.post('/api/runs/' + interrupted.id + '/resume', {}, 'resume_once_123')).status).toBe(200);
    expect(web.app.store.calls(interrupted.id)).toHaveLength(calls);
    const unknown = web.app.createRun({ objective: 'uncertain', workspace: web.workspace, binding, card: web.options.card });
    web.app.store.updateRun(unknown.id, { status: 'failed', error: 'UNKNOWN_WRITE: pending inspection' });
    web.app.store.putCall({ id: 'unknown-write', runId: unknown.id, step: 0, kind: 'tool', name: 'file.patch', status: 'unknown', effect: 'write', requestRef: web.app.store.blob({}), reservedTokens: 0 });
    expect((await web.post('/api/runs/' + unknown.id + '/resume', {}, 'unknown_resume_123')).status).toBe(202);
    await new Promise(resolve => setImmediate(resolve));
    expect(web.app.store.run(unknown.id).status).toBe('failed');
    expect(web.app.store.calls(unknown.id)).toHaveLength(1);
    expect(web.app.store.events(unknown.id).at(-1)).toMatchObject({ type: 'web.command_failed', data: { code: 'UNKNOWN_WRITE' } });
  });
  it('exposes the collaboration panel, pending items and targeted agent controls as static assets', () => {
    for (const id of ['collab-toggle', 'collab-badge', 'collab-content', 'inspector-title', 'inspector-hint']) expect(workbenchHtml).toContain('id="' + id + '"');
    expect(workbenchHtml).toContain('协作'); expect(workbenchHtml).toContain('待处理');
    expect(workbenchHtml).toContain('aria-controls="evidence"');
    expect(workbenchHtml).not.toContain('onclick=');
    for (const route of ['/collaboration', '/agents/', '/snapshot', '/artifacts', '/evidence/', '/answer', '/resume', '/input']) expect(workbenchScript).toContain(route);
    expect(workbenchScript).toContain('localStorage'); expect(workbenchScript).toContain('kodo.viewed.');
    expect(workbenchScript).toContain('textContent'); expect(workbenchScript).toContain('agent-input-');
    for (const label of ['问题', '失败', '未知写入', '中断', '待核验', '操作失败', '协作阻塞']) expect(workbenchScript).toContain(label);
    for (const text of ['已结束', '宿主验收通过', '已结束但未验收', '验收失败', '决定版本已变化需复核', '不代表验收', '补充要求', '返回协作面板', '标记已查看']) expect(workbenchScript).toContain(text);
    expect(workbenchScript).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(workbenchScript).not.toContain('onclick=');
  });
  it('exposes the reconnect status bar, recovery panel and capability package development panel as static assets', () => {
    for (const id of ['connection-bar', 'connection-dot', 'connection-text', 'connection-retry', 'recovery-toggle', 'recovery-badge', 'recovery-content', 'packages-toggle', 'packages-panel', 'packages-close', 'packages-refresh', 'packages-content', 'packages-hint']) expect(workbenchHtml).toContain('id="' + id + '"');
    for (const text of ['恢复与核实', '能力包', '未连接', '兼容性诊断', '依赖准备', '运行版本']) expect(workbenchHtml).toContain(text);
    expect(workbenchHtml).not.toMatch(/innerHTML|outerHTML|document\.write/);
    expect(workbenchHtml).not.toContain('onclick=');
    for (const route of ['/api/recovery', '/api/packages', '/api/packages/jobs/', '/prepare', '/adopt', '/rollback']) expect(workbenchScript).toContain(route);
    for (const text of ['serverId', '补齐', '已重新连接', '连接中断，正在重新连接', '服务已重启或会话失效，请用新的启动密钥重新连接', '无法连接本地服务', '已连接']) expect(workbenchScript).toContain(text);
    for (const label of ['待恢复', '待核实写入', '排队续接', '操作失败']) expect(workbenchScript).toContain(label);
    for (const text of ['当前 Web 服务启用', '准备依赖', '设为默认版本', '回退默认版本', '任务卡片在创建时固定', 'provenance', 'treeDigest', 'needs_configuration', 'incompatible']) expect(workbenchScript).toContain(text);
    expect(workbenchScript).toContain('aria-expanded');
    expect(workbenchScript).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    expect(workbenchScript).not.toContain('onclick=');
  });
});
