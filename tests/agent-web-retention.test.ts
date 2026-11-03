import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Application } from '../src/application/index.js';
import { createLocalServer } from '../src/web/server.js';
import { workbenchScript } from '../src/web/workbench.js';
import type { Card } from '../src/runtime/types.js';
import type { RetentionDraft } from '../src/agents/retention.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

async function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'kodo-agent-web-'));
  const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
  let asked = false;
  const app = new Application(path.join(root, 'state'), { async complete(request) {
    if (!asked && request.tools.some(tool => tool.name === 'ask_user')) { asked = true; return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'fixture-question', name: 'ask_user', arguments: JSON.stringify({ question: 'Ready to finish this fixture task?' }) }] }, finishReason: 'tool_calls' }; }
    return { message: { role: 'assistant', content: 'Completed the ordinary fixture task.' }, finishReason: 'stop', usage: { input: 50, output: 10 } }; } }, undefined, { agentFactors: { D: false, E: false, A: false, B: false, C: false } });
  const card: Card = { id: 'test/reader', version: '1.0.0', name: 'Reader', description: 'Read ordinary project files.', digest: 'reader-fixture', prompt: 'Inspect the project.', tools: ['file.read'] };
  const binding = { model: 'test-model', baseURL: 'http://127.0.0.1:1/v1', apiKeyEnv: 'FIXTURE_KEY', limits: { context: 256000, output: 8192 } };
  const main = app.createRun({ workspace, binding, card, permissions: ['read'], objective: 'Read the workspace.' });
  const child = app.spawnAgent(main.sessionId, { objective: 'Read the directory.' });
  await app.run(child.id);
  const draft = app.retention.propose(main.sessionId, { run_id: child.id, name: 'Reusable reader' });
  const server = await createLocalServer(app, { workspace, binding, card, permissions: ['read'] });
  cleanups.push(async () => { await server.close(); await app.shutdown(); rmSync(root, { recursive: true, force: true }); });
  const auth = await fetch(server.origin + '/api/auth', { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: server.startupSecret }) });
  const cookie = auth.headers.get('set-cookie')!.split(';')[0]!;
  const { csrf } = await auth.json() as { csrf: string };
  const get = (url: string) => fetch(server.origin + url, { headers: { Cookie: cookie } });
  const post = (action: string, body: unknown, key: string) => fetch(`${server.origin}/api/runs/${main.id}/agent-drafts/${draft.id}/${action}`, { method: 'POST', headers: { Cookie: cookie, Origin: server.origin, 'Content-Type': 'application/json', 'X-Kodo-CSRF': csrf, 'Idempotency-Key': key }, body: JSON.stringify(body) });
  const finish = async (): Promise<void> => { const question = app.coordinator.mailbox.userQuestions(main.sessionId)[0]; if (question) app.answer(question.id, 'Finish the fixture.'); await app.run(main.id); };
  return { app, main, draft, get, post, finish };
}

describe('workbench agent proposals', () => {
  it('presents proposals after the final answer and explicitly approves edited content', async () => {
    const { app, main, draft, get, post, finish } = await setup();
    let response = await get(`/api/runs/${main.id}/collaboration`);
    let panel = await response.json() as { pending: { kind: string }[]; drafts: RetentionDraft[] };
    expect(panel.pending.some(item => item.kind === 'agent_proposal')).toBe(false);
    expect(panel.drafts.map(item => item.id)).toContain(draft.id);
    await finish();
    response = await get(`/api/runs/${main.id}/collaboration`);
    panel = await response.json() as typeof panel;
    expect(panel.pending.some(item => item.kind === 'agent_proposal')).toBe(true);
    const edited = await post('edit', { digest: draft.digest, metadata: { name: 'Reviewed reader' } }, 'agent-draft-edit-1');
    expect(edited.status, await edited.clone().text()).toBe(202);
    const update = (await edited.json() as { draft: RetentionDraft }).draft;
    expect(update.digest).not.toBe(draft.digest);
    expect(update.status).toBe('draft');
    const approved = await post('approve', { digest: update.digest }, 'agent-draft-approve-1');
    expect(approved.status, await approved.clone().text()).toBe(202);
    expect((await approved.json() as { draft: RetentionDraft }).draft.status).toBe('approved');
    expect(app.store.card(update.card.id, update.card.version)?.digest).toBe(update.card.digest);
    const replay = await post('approve', { digest: update.digest }, 'agent-draft-approve-1');
    expect(replay.status).toBe(200);
  });

  it('keeps skipped proposals inspectable and retains an executable workbench script', async () => {
    const { main, draft, post, get, finish } = await setup();
    await finish();
    const skipped = await post('skip', { digest: draft.digest }, 'agent-draft-skip-1');
    expect(skipped.status).toBe(202);
    const response = await get(`/api/runs/${main.id}/agent-drafts`);
    expect((await response.json() as { drafts: RetentionDraft[] }).drafts).toEqual(expect.arrayContaining([expect.objectContaining({ id: draft.id, status: 'draft' })]));
    expect(() => new vm.Script(workbenchScript)).not.toThrow();
  });
});
