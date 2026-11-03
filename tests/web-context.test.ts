import { storageTestConnection } from '../src/storage/test-access.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Application } from '../src/application/index.js';
import { defaultCompactionPolicy } from '../src/runtime/context.js';
import { createLocalServer } from '../src/web/index.js';
import type { LocalServerHandle, LocalServerOptions } from '../src/web/index.js';
import { workbenchHtml, workbenchScript } from '../src/web/workbench.js';
import { answer, binding, call } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(extra: Partial<LocalServerOptions> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'kodo-web-context-')); const workspace = path.join(root, 'workspace'); mkdirSync(workspace);
  const app = new Application(path.join(root, 'data'), { async complete() { return answer('上下文视图'); } }, undefined, { exploration: true });
  const options: LocalServerOptions = { workspace, binding, permissions: ['read'], card: { id: 'test/web-context', version: '1.0.0', name: 'Web context test', digest: 'web-context-test', prompt: 'Complete the task.', tools: [] }, ...extra };
  const server = await createLocalServer(app, options);
  cleanups.push(async () => { await server.close(); await app.shutdown(); rmSync(root, { recursive: true, force: true }); });
  async function auth(handle: LocalServerHandle = server) {
    const response = await fetch(handle.origin + '/api/auth', { method: 'POST', headers: { Origin: handle.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: handle.startupSecret }) });
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!; const body = await response.json() as { csrf: string };
    return { cookie, csrf: body.csrf };
  }
  const credentials = await auth();
  function headers(extraHeaders: Record<string, string> = {}) { return { Cookie: credentials.cookie, Origin: server.origin, 'Content-Type': 'application/json', 'X-Kodo-CSRF': credentials.csrf, ...extraHeaders }; }
  const get = (url: string) => fetch(server.origin + url, { headers: headers() });
  const post = (url: string, body: unknown, key: string, override: Record<string, string> = {}) => fetch(server.origin + url, { method: 'POST', headers: headers({ 'Idempotency-Key': key, ...override }), body: JSON.stringify(body) });
  return { app, root, workspace, options, credentials, headers, get, post, get origin() { return server.origin; } };
}
type Web = Awaited<ReturnType<typeof setup>>;

async function json<T>(response: Response): Promise<T> { return await response.json() as T; }
function createRun(web: Web, objective = 'Local knowledge task') {
  return web.app.createRun({ objective, workspace: web.workspace, binding, card: web.options.card });
}
function seedKnowledge(web: Web, options: { objective?: string; summary?: string; content?: string; questionId?: string; file?: string } = {}) {
  const knowledge = web.app.coordinator.knowledge;
  if (!knowledge) throw new Error('project knowledge is unavailable in this test host');
  const file = options.file ?? 'source.ts'; const questionId = options.questionId ?? 'contract';
  const content = options.content ?? 'export const contract = "first";\n';
  writeFileSync(path.join(web.workspace, file), content);
  const owner = createRun(web, options.objective ?? 'Inspect the project contract.');
  const request = call('file.read', { path: file }, randomUUID());
  web.app.store.putCall({ id: request.id, runId: owner.id, step: 0, kind: 'tool', name: 'file.read', status: 'succeeded', effect: 'read', evidencePermission: 'read', decisionVersion: 0, requestRef: web.app.store.blob(request), resultRef: web.app.store.blob({ content, hash: createHash('sha256').update(content).digest('hex'), offset: 1, contentOffset: 0 }), reservedTokens: 0 });
  const finalText = JSON.stringify({ question_id: questionId, summary: options.summary ?? 'The contract is declared in source.ts.', claims: [{ text: 'source.ts declares the contract.', basis: 'source_observation', evidence_ids: [request.id] }], hypotheses: [], open_questions: [] });
  const ref = knowledge.persist(knowledge.prepare(owner.id, finalText, questionId));
  return { ownerId: owner.id, ref, evidenceId: request.id, content };
}

interface ErrorView { error: { code: string; message: string } }
interface ContextReportView {
  runId: string; experimental: boolean; estimatedInputTokens: number; messageCount: number;
  parts: Record<string, number>; usage: Record<string, number>; sessionUsage: Record<string, number>;
  policy: unknown; modelLimits: unknown; hiddenObservations: number; latestCompaction: unknown; summary: unknown; note: string;
}
interface KnowledgeSummaryView {
  id: string; revision: number; summary: string; scope: string[]; freshness: string; confirmation: string;
  completeness: string; sourceAvailable: boolean; decisionStale: boolean;
  read: { tool: string; args: { id: string; revision: number } };
}
interface KnowledgeNodeView { id: string; parentId: string | null; kind: 'folder' | 'entry'; title: string; knowledgeId: string | null; knowledge?: KnowledgeSummaryView; adoptedRevisions?: number[] }
interface KnowledgeBrowseView { items: KnowledgeNodeView[]; next: string | null }
interface KnowledgeSearchView { items: KnowledgeSummaryView[]; next: number | null }
interface KnowledgeReadView {
  id: string; revision: number; freshness: string; confirmation: string; completeness: string; sourceAvailable: boolean;
  text: string; offset: number; totalChars: number; complete: boolean; next: { offset?: number } | null; note: string;
}
interface ReceiptView { requestId: string; runId: string; sessionId: string; status: string; node?: KnowledgeNodeView }

describe('loopback web context and knowledge views', () => {
  it('reports the estimated context structure and denies unknown, foreign or unauthenticated runs', async () => {
    const web = await setup();
    const run = createRun(web);
    const response = await web.get('/api/runs/' + run.id + '/context');
    expect(response.status).toBe(200);
    const report = await json<ContextReportView>(response);
    expect(report).toMatchObject({
      runId: run.id, experimental: true, summary: null, latestCompaction: null, latestAssembly: null, hiddenObservations: 0, policy: defaultCompactionPolicy, assemblyPolicy: null,
      messageCount: expect.any(Number), estimatedInputTokens: expect.any(Number), note: expect.any(String),
      parts: { rules: expect.any(Number), tools: expect.any(Number), state: expect.any(Number), summary: 0, recent: expect.any(Number), protocolAndCalibration: expect.any(Number) },
      usage: { modelCalls: 0, summaryCalls: 0, knownInput: 0, knownOutput: 0, cacheRead: 0, cacheWrite: 0, unknownCalls: 0, reservedUnknownTokens: 0, peakInput: 0, estimatedPeakInput: 0, recoveryReads: 0 },
      sessionUsage: expect.objectContaining({ estimatedPeakInput: 0, modelCalls: 0 }),
    });
    expect(report.estimatedInputTokens).toBeGreaterThan(0);
    expect(report.messageCount).toBeGreaterThan(0);
    expect(report.modelLimits).not.toBeNull();
    expect(report.note).toContain('Hidden observations are retained');
    // The report shape stays aligned with src/runtime/context-inspection.ts.
    expect(Object.keys(report).sort()).toEqual(['assemblyPolicy', 'estimatedInputTokens', 'experimental', 'hiddenObservations', 'lastRequestLayers', 'latestAssembly', 'latestCompaction', 'layers', 'messageCount', 'modelLimits', 'note', 'parts', 'policy', 'prefixSharing', 'runId', 'sessionUsage', 'summary', 'usage']);
    expect(Object.keys(report.parts).sort()).toEqual(['protocolAndCalibration', 'recent', 'rules', 'state', 'summary', 'tools']);
    expect(Object.keys(report.usage).sort()).toEqual(['cacheRead', 'cacheWrite', 'estimatedPeakInput', 'knownInput', 'knownOutput', 'modelCalls', 'peakInput', 'recoveryReads', 'reservedUnknownTokens', 'summaryCalls', 'unknownCalls']);
    const foreign = web.app.createRun({ objective: 'foreign context', workspace: web.root, binding, card: web.options.card });
    expect((await web.get('/api/runs/' + foreign.id + '/context')).status).toBe(404);
    expect((await web.get('/api/runs/does-not-exist/context')).status).toBe(404);
    expect((await fetch(web.origin + '/api/runs/' + run.id + '/context')).status).toBe(401);
  });

  it('browses the virtual unclassified folder and denies unknown, foreign or unauthenticated runs', async () => {
    const web = await setup();
    const run = createRun(web);
    // Only branches with visible knowledge are disclosed: an empty project has no rows at all.
    const empty = await json<KnowledgeBrowseView>(await web.get('/api/runs/' + run.id + '/knowledge'));
    expect(empty).toEqual({ items: [], next: null });
    seedKnowledge(web);
    const root = await json<KnowledgeBrowseView>(await web.get('/api/runs/' + run.id + '/knowledge'));
    expect(root.items).toContainEqual({ id: 'unclassified', parentId: null, kind: 'folder', title: '未分类', knowledgeId: null });
    expect(root.next).toBeNull();
    const folder = await json<KnowledgeBrowseView>(await web.get('/api/runs/' + run.id + '/knowledge?parentId=unclassified'));
    expect(folder.items).toHaveLength(1); expect(folder.next).toBeNull();
    const entry = folder.items[0]!;
    expect(entry).toMatchObject({ kind: 'entry', parentId: 'unclassified', knowledgeId: 'contract', title: expect.any(String), adoptedRevisions: [] });
    expect(entry.knowledge).toMatchObject({ id: 'contract', revision: 1, freshness: 'current', confirmation: 'candidate', completeness: 'answered', sourceAvailable: true, decisionStale: false });
    expect(entry.knowledge!.read).toEqual({ tool: 'knowledge.read', args: { id: 'contract', revision: 1 } });
    const missingFolder = await json<KnowledgeBrowseView>(await web.get('/api/runs/' + run.id + '/knowledge?parentId=folder-does-not-exist'));
    expect(missingFolder).toEqual({ items: [], next: null });
    expect((await web.get('/api/runs/does-not-exist/knowledge')).status).toBe(404);
    const foreign = web.app.createRun({ objective: 'foreign knowledge', workspace: web.root, binding, card: web.options.card });
    expect((await web.get('/api/runs/' + foreign.id + '/knowledge')).status).toBe(404);
    expect((await fetch(web.origin + '/api/runs/' + run.id + '/knowledge')).status).toBe(401);
  });

  it('clamps browse pages to twenty nodes and pages with the returned cursor', async () => {
    const web = await setup();
    const run = createRun(web);
    const knowledge = web.app.coordinator.knowledge!;
    for (let index = 0; index < 21; index++) knowledge.createFolder(run.id, 'Folder ' + index);
    const first = await json<KnowledgeBrowseView>(await web.get('/api/runs/' + run.id + '/knowledge?limit=100'));
    expect(first.items).toHaveLength(20);
    expect(first.items.every(item => item.kind === 'folder')).toBe(true);
    expect(first.next).not.toBeNull();
    const second = await json<KnowledgeBrowseView>(await web.get('/api/runs/' + run.id + '/knowledge?limit=20&cursor=' + encodeURIComponent(first.next!)));
    expect(second.items).toHaveLength(1); expect(second.next).toBeNull();
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(21);
    expect((await web.get('/api/runs/' + run.id + '/knowledge?limit=abc')).status).toBe(400);
  });

  it('searches saved summaries and evidence with a validated scope', async () => {
    const web = await setup();
    const run = createRun(web);
    seedKnowledge(web);
    const summary = await json<KnowledgeSearchView>(await web.get('/api/runs/' + run.id + '/knowledge/search?query=CONTRACT&in=summary'));
    expect(summary.items).toHaveLength(1); expect(summary.next).toBeNull();
    const item = summary.items[0]!;
    expect(item).toMatchObject({ id: 'contract', revision: 1, freshness: 'current', confirmation: 'candidate', completeness: 'answered', sourceAvailable: true, decisionStale: false });
    expect(item.read).toEqual({ tool: 'knowledge.read', args: { id: 'contract', revision: 1 } });
    expect(Object.keys(item).sort()).toEqual(['completeness', 'confirmation', 'decisionStale', 'freshness', 'id', 'read', 'revision', 'scope', 'sourceAvailable', 'summary']);
    // Evidence scope only scans stored snippets, while summary scope scans conclusions and metadata.
    expect((await json<KnowledgeSearchView>(await web.get('/api/runs/' + run.id + '/knowledge/search?query=declared&in=evidence'))).items).toEqual([]);
    const evidence = await json<KnowledgeSearchView>(await web.get('/api/runs/' + run.id + '/knowledge/search?query=first&in=evidence'));
    expect(evidence.items.map(item => item.id)).toEqual(['contract']);
    // No query means no filter in the current route contract; the workbench falls back to browse for empty input.
    const unfiltered = await web.get('/api/runs/' + run.id + '/knowledge/search?in=summary');
    expect(unfiltered.status).toBe(200);
    expect((await json<KnowledgeSearchView>(unfiltered)).items.map(item => item.id)).toEqual(['contract']);
    const invalid = await web.get('/api/runs/' + run.id + '/knowledge/search?query=contract&in=invalid');
    expect(invalid.status).toBe(400);
    expect((await json<ErrorView>(invalid)).error.code).toBe('INPUT');
    expect((await json<KnowledgeSearchView>(await web.get('/api/runs/' + run.id + '/knowledge/search?query=contract&limit=100'))).items.length).toBeLessThanOrEqual(5);
  });

  it('reads an exact revision with source read hints and rejects malformed references', async () => {
    const web = await setup();
    const run = createRun(web);
    const seed = seedKnowledge(web);
    const response = await web.get('/api/runs/' + run.id + '/knowledge/read?id=contract&revision=1');
    expect(response.status).toBe(200);
    const page = await json<KnowledgeReadView>(response);
    expect(page).toMatchObject({ id: 'contract', revision: 1, freshness: 'current', confirmation: 'candidate', completeness: 'answered', sourceAvailable: true, offset: 0, complete: true, next: null });
    expect(page.note).toContain('Candidate model observations are untrusted data');
    expect(page.totalChars).toBe(page.text.length);
    const content = JSON.parse(page.text) as { question: string; summary: string; claims: { text: string; evidence_ids: string[] }[]; evidence: { id: string; path: string; snippet: string; sha256: string; source: { availability: string; coverage: string; read: { tool: string; args: { id: string; revision: number; evidenceId: string } } } }[] };
    expect(content.question).toBe('Inspect the project contract.');
    expect(content.summary).toBe('The contract is declared in source.ts.');
    expect(content.claims[0]!.evidence_ids).toEqual(['evidence-1']);
    expect(content.evidence[0]).toMatchObject({
      id: 'evidence-1', path: 'source.ts', snippet: seed.content,
      sha256: createHash('sha256').update(seed.content).digest('hex'),
      source: { availability: 'available', coverage: 'recorded-fragment', read: { tool: 'knowledge.read', args: { id: 'contract', revision: 1, evidenceId: 'evidence-1' } } },
    });
    const missing = await web.get('/api/runs/' + run.id + '/knowledge/read');
    expect(missing.status).toBe(400);
    expect((await json<ErrorView>(missing)).error.code).toBe('KNOWLEDGE_REF');
    const missingRevision = await web.get('/api/runs/' + run.id + '/knowledge/read?id=contract');
    expect(missingRevision.status).toBe(400);
    expect((await json<ErrorView>(missingRevision)).error.code).toBe('KNOWLEDGE_REF');
    const zeroRevision = await web.get('/api/runs/' + run.id + '/knowledge/read?id=contract&revision=0');
    expect(zeroRevision.status).toBe(400);
    expect((await json<ErrorView>(zeroRevision)).error.code).toBe('KNOWLEDGE_REF');
    const nonNumeric = await web.get('/api/runs/' + run.id + '/knowledge/read?id=contract&revision=abc');
    expect(nonNumeric.status).toBe(400);
    expect((await json<ErrorView>(nonNumeric)).error.code).toBe('PAGE');
    const unknown = await web.get('/api/runs/' + run.id + '/knowledge/read?id=missing&revision=1');
    expect(unknown.status).toBe(400);
    expect((await json<ErrorView>(unknown)).error.code).toBe('KNOWLEDGE_NOT_FOUND');
    const beyond = await web.get('/api/runs/' + run.id + '/knowledge/read?id=contract&revision=1&offset=999999');
    expect(beyond.status).toBe(400);
    expect((await json<ErrorView>(beyond)).error.code).toBe('KNOWLEDGE_CURSOR');
  });

  it('pages immutable knowledge versions from a revision cursor', async () => {
    const web = await setup();
    const run = createRun(web);
    for (let revision = 1; revision <= 6; revision++) {
      const seed = seedKnowledge(web, { summary: 'Contract revision ' + revision + '.' });
      expect(seed.ref).toEqual({ id: 'contract', revision });
    }
    const first = await json<KnowledgeSearchView>(await web.get('/api/runs/' + run.id + '/knowledge/versions?id=contract'));
    expect(first.items.map(item => item.revision)).toEqual([1, 2, 3, 4, 5]); expect(first.next).toBe(5);
    expect(first.items[0]!.read).toEqual({ tool: 'knowledge.read', args: { id: 'contract', revision: 1 } });
    expect(first.items[0]!.summary).toBe('Contract revision 1.');
    const rest = await json<KnowledgeSearchView>(await web.get('/api/runs/' + run.id + '/knowledge/versions?id=contract&after=5'));
    expect(rest.items.map(item => item.revision)).toEqual([6]); expect(rest.next).toBeNull();
    expect((await web.get('/api/runs/' + run.id + '/knowledge/versions?id=contract&after=abc')).status).toBe(400);
  });

  it('organizes knowledge through idempotent host commands and rejects replayed mismatches', async () => {
    const web = await setup();
    const run = createRun(web);
    seedKnowledge(web);
    const folderCount = () => storageTestConnection(web.app.store).prepare("SELECT COUNT(*) AS count FROM knowledge_nodes WHERE kind='folder'").get() as { count: number };
    const created = await web.post('/api/runs/' + run.id + '/knowledge/folder', { title: 'Protocols', parentId: null }, 'folder_create_01');
    expect(created.status).toBe(202);
    const receipt = await json<ReceiptView>(created);
    expect(receipt).toMatchObject({ requestId: 'folder_create_01', runId: run.id, sessionId: run.sessionId, status: 'queued', node: { parentId: null, kind: 'folder', title: 'Protocols', knowledgeId: null } });
    const folderId = receipt.node!.id;
    expect(folderId).toMatch(/^folder-/);
    const replay = await web.post('/api/runs/' + run.id + '/knowledge/folder', { title: 'Protocols', parentId: null }, 'folder_create_01');
    expect(replay.status).toBe(200);
    expect(await json<ReceiptView>(replay)).toEqual(receipt);
    expect(folderCount()).toEqual({ count: 1 });
    const conflict = await web.post('/api/runs/' + run.id + '/knowledge/folder', { title: 'Different', parentId: null }, 'folder_create_01');
    expect(conflict.status).toBe(409);
    expect((await json<ErrorView>(conflict)).error.code).toBe('REQUEST_CONFLICT');
    expect(folderCount()).toEqual({ count: 1 });
    expect((await web.post('/api/runs/' + run.id + '/knowledge/folder', { title: 'No CSRF' }, 'folder_no_csrf1', { 'X-Kodo-CSRF': '' })).status).toBe(403);
    expect((await web.post('/api/runs/' + run.id + '/knowledge/folder', { title: 'Short key' }, 'short')).status).toBe(400);
    const organized = await web.post('/api/runs/' + run.id + '/knowledge/organize', { knowledgeId: 'contract', parentId: folderId }, 'organize_seed_01');
    expect(organized.status).toBe(202);
    const organizedReceipt = await json<ReceiptView>(organized);
    expect(organizedReceipt.node).toMatchObject({ parentId: folderId, kind: 'entry', knowledgeId: 'contract' });
    const entryNodeId = organizedReceipt.node!.id;
    const folderPage = await json<KnowledgeBrowseView>(await web.get('/api/runs/' + run.id + '/knowledge?parentId=' + encodeURIComponent(folderId)));
    expect(folderPage.items).toEqual([expect.objectContaining({ id: entryNodeId, parentId: folderId, kind: 'entry', knowledgeId: 'contract' })]);
    const blocked = await web.post('/api/runs/' + run.id + '/knowledge/remove-folder', { nodeId: folderId }, 'remove_blocked_01');
    expect(blocked.status).toBe(400);
    expect((await json<ErrorView>(blocked)).error.code).toBe('KNOWLEDGE_NODE');
    expect((await web.post('/api/runs/' + run.id + '/knowledge/organize', { nodeId: entryNodeId, parentId: null }, 'organize_move_02')).status).toBe(202);
    const removed = await web.post('/api/runs/' + run.id + '/knowledge/remove-folder', { nodeId: folderId }, 'folder_remove_01');
    expect(removed.status).toBe(202);
    expect((await json<ReceiptView>(removed)).node).toBeUndefined();
    const root = await json<KnowledgeBrowseView>(await web.get('/api/runs/' + run.id + '/knowledge'));
    expect(root.items.map(item => item.id)).not.toContain(folderId);
    expect(root.items.some(item => item.id === 'unclassified')).toBe(true);
    expect((await web.post('/api/runs/missing-run/knowledge/folder', { title: 'Nope' }, 'folder_missing_01')).status).toBe(404);
    const foreign = web.app.createRun({ objective: 'foreign organiser', workspace: web.root, binding, card: web.options.card });
    expect((await web.post('/api/runs/' + foreign.id + '/knowledge/folder', { title: 'Nope' }, 'folder_foreign_01')).status).toBe(404);
  });

  it('serves the context and knowledge workbench controls over HTTP', async () => {
    const web = await setup();
    for (const id of ['context-toggle', 'evidence-content', 'knowledge-toggle', 'knowledge-panel', 'knowledge-search', 'knowledge-query', 'knowledge-scope', 'knowledge-path', 'knowledge-list', 'knowledge-folder', 'folder-title', 'knowledge-detail', 'knowledge-close']) expect(workbenchHtml).toContain('id="' + id + '"');
    for (const route of ["/context", "/knowledge", "/search", "/read", "/versions", "/folder", "/organize", "/remove-folder"]) expect(workbenchScript).toContain(route);
    expect(workbenchScript).toContain('renderContext');
    expect(workbenchScript).toContain('browseKnowledge');
    const page = await fetch(web.origin + '/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toBe(workbenchHtml);
  });
});
