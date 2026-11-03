import { storageTestConnection } from '../src/storage/test-access.js';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ProjectKnowledge } from '../src/knowledge/index.js';
import { knowledgeTools } from '../src/knowledge/tools.js';
import { Store } from '../src/storage/index.js';
import { binding, call, fixture, temp } from './helpers.js';

function setup() {
  const context = fixture();
  const { app, runId, root } = context;
  writeFileSync(path.join(root, 'source.ts'), 'export const contract = "first";\n');
  const knowledge = new ProjectKnowledge(app.store, { ownerId: 'test-owner' });
  const observe = async (file = 'source.ts', owner = runId) => {
    const request = call('file.read', { path: file }, randomUUID());
    const result = await app.coordinator.tools.execute(owner, 'file.read', { path: file }, new AbortController().signal);
    app.store.putCall({ id: request.id, runId: owner, step: 0, kind: 'tool', name: 'file.read', status: 'succeeded', effect: 'read', evidencePermission: 'read', decisionVersion: 0, requestRef: app.store.blob(request), resultRef: app.store.blob(result), reservedTokens: 0 });
    return request.id;
  };
  const result = (ids: string[], extra: Record<string, unknown> = {}) => JSON.stringify({ question_id: 'contract', summary: 'The contract is declared in source.ts.', claims: ids.length ? [{ text: 'source.ts declares the contract.', basis: 'source_observation', evidence_ids: ids }] : [], hypotheses: [], open_questions: [], ...extra });
  const nextRun = (workspace = root) => app.createRun({ objective: 'Use a project contract.', workspace, permissions: ['read'], binding }).id;
  return { ...context, knowledge, observe, result, nextRun };
}

describe('private project knowledge', () => {
  it('derives hashes, paths and excerpts from actual successful native reads and keeps confirmation separate from freshness', async () => {
    const { knowledge, observe, result, runId, app } = setup();
    const evidence = await observe();
    const prepared = knowledge.prepare(runId, result([evidence], { open_questions: ['Is the contract stable across releases?'] }));
    expect(storageTestConnection(app.store).prepare('SELECT COUNT(*) AS count FROM knowledge_versions').get()).toEqual({ count: 0 });
    const ref = knowledge.persist(prepared);
    const page = knowledge.read(runId, ref);
    const body = JSON.parse(page.text);
    expect(page).toMatchObject({ freshness: 'current', confirmation: 'candidate', completeness: 'partial', sourceAvailable: true, decisionStale: false });
    expect(body.evidence).toEqual([expect.objectContaining({ path: 'source.ts', sourceCallId: evidence, snippet: 'export const contract = "first";\n', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
    expect(body.claims[0].evidence_ids).toEqual(['evidence-1']);
    expect(app.store.events(runId).at(-1)).toMatchObject({ type: 'knowledge.saved', data: { id: 'contract', revision: 1, freshness: 'current', completeness: 'partial' } });
  });

  it('rejects unsupported evidence, foreign calls, failed calls and forged metadata', async () => {
    const { knowledge, observe, result, runId, app, nextRun } = setup();
    const evidence = await observe();
    expect(() => knowledge.prepare(runId, 'not JSON')).toThrow('JSON');
    expect(() => knowledge.prepare(runId, result(['invented']))).toThrow('existing successful');
    expect(() => knowledge.prepare(runId, result([evidence], { dependencies: [{ path: '.env', sha256: '0'.repeat(64) }] }))).toThrow('use only');
    expect(() => knowledge.prepare(runId, result([evidence], { claims: [{ text: 'All callers were found.', basis: 'execution', evidence_ids: [evidence] }] }))).toThrow('only source_observation');
    const original = app.store.call(evidence);
    app.store.putCall({ ...original, name: 'file.search' });
    expect(() => knowledge.prepare(runId, result([evidence]))).toThrow('successful file.read');
    app.store.putCall({ ...original, status: 'failed' });
    expect(() => knowledge.prepare(runId, result([evidence]))).toThrow('successful file.read');
    app.store.putCall({ ...original, runId: nextRun() });
    expect(() => knowledge.prepare(runId, result([evidence]))).toThrow('this exploration');
    app.store.putCall(original);
    expect(() => knowledge.prepare(runId, result([], { summary: 'Everything is known.' }))).toThrow('unresolved questions');
    expect(() => knowledge.persist({ runId, projectId: 'model-supplied', id: 'contract' })).toThrow('prepared result');
  });

  it('hides the whole entry when any source becomes unauthorized, including its summary', async () => {
    const { knowledge, observe, result, runId, app, root, nextRun } = setup();
    mkdirSync(path.join(root, 'private'));
    writeFileSync(path.join(root, 'private', 'source.ts'), 'private contract');
    const ref = knowledge.persist(knowledge.prepare(runId, result([await observe(), await observe('private/source.ts')])));
    const requester = nextRun();
    app.store.updateRun(requester, { scope: { read: ['source.ts'] } });
    expect(knowledge.search(requester).items).toEqual([]);
    expect(() => knowledge.read(requester, ref)).toThrow('not available');
    app.store.updateRun(requester, { scope: {} });
    expect(knowledge.search(requester).items).toHaveLength(1);
    app.store.updateRun(requester, { permissions: [] });
    expect(() => knowledge.search(requester)).toThrow('read permission');
  });

  it('isolates host owners, canonical workspaces and independent data stores', async () => {
    const { knowledge, observe, result, runId, app, root, nextRun } = setup();
    const ref = knowledge.persist(knowledge.prepare(runId, result([await observe()])));
    const sameWorkspace = nextRun(path.join(root, '.'));
    expect(knowledge.read(sameWorkspace, ref).freshness).toBe('current');
    expect(new ProjectKnowledge(app.store, { ownerId: 'different-owner' }).search(sameWorkspace).items).toEqual([]);
    expect(knowledge.search(nextRun(temp())).items).toEqual([]);
    const otherStore = new Store(path.join(temp(), 'isolated-state'));
    try {
      otherStore.putSession(app.store.session(app.store.run(runId).sessionId));
      otherStore.putRun(app.store.run(runId));
      expect(new ProjectKnowledge(otherStore, { ownerId: 'test-owner' }).search(runId).items).toEqual([]);
    } finally { otherStore.close(); }
  });

  it('checks uncommitted content and missing files on every read and prevents stale adoption', async () => {
    const { knowledge, observe, result, runId, root, app } = setup();
    const ref = knowledge.persist(knowledge.prepare(runId, result([await observe()])));
    knowledge.adopt(runId, [{ ...ref, purpose: 'preserve API' }]);
    knowledge.adopt(runId, [{ ...ref, purpose: 'preserve API' }]);
    expect(app.store.events(runId).filter(event => event.type === 'knowledge.used')).toHaveLength(1);
    expect(knowledge.read(runId, ref).confirmation).toBe('candidate');
    writeFileSync(path.join(root, 'source.ts'), 'export const contract = "second";\n');
    expect(knowledge.read(runId, ref).freshness).toBe('stale');
    expect(() => knowledge.validateUse(runId, ref)).toThrow('re-read and review');
    unlinkSync(path.join(root, 'source.ts'));
    expect(knowledge.read(runId, ref).freshness).toBe('stale');
  });

  it('marks changed-during-collection results unknown and keeps evidence-free results in their source session', async () => {
    const { knowledge, observe, result, runId, root, nextRun } = setup();
    const prepared = knowledge.prepare(runId, result([await observe()]));
    writeFileSync(path.join(root, 'source.ts'), 'changed after collection');
    const ref = knowledge.persist(prepared);
    expect(knowledge.read(runId, ref)).toMatchObject({ freshness: 'unknown', confirmation: 'candidate' });
    expect(() => knowledge.validateUse(runId, ref)).toThrow('unknown');
    const another = nextRun();
    const unknown = knowledge.persist(knowledge.prepare(another, result([], { open_questions: ['Could not inspect the required source.'] })));
    expect(knowledge.read(another, unknown)).toMatchObject({ freshness: 'unknown', completeness: 'partial' });
    expect(() => knowledge.read(runId, unknown)).toThrow('not available');
    expect(knowledge.search(nextRun()).items.map(item => item.revision)).toEqual([1]);
  });

  it('keeps conflicting revisions immutable and does not silently overwrite a previously saved exploration', async () => {
    const { knowledge, observe, result, runId, nextRun } = setup();
    const evidence = await observe();
    const original = knowledge.persist(knowledge.prepare(runId, result([evidence])));
    expect(knowledge.persist(knowledge.prepare(runId, result([evidence])))).toEqual(original);
    expect(() => knowledge.persist(knowledge.prepare(runId, result([evidence], { summary: 'A conflicting conclusion.' })))).toThrow('different immutable result');
    const second = nextRun();
    const newer = knowledge.persist(knowledge.prepare(second, result([await observe('source.ts', second)], { summary: 'Another interpretation of the same source.' })));
    expect(newer).toEqual({ id: 'contract', revision: 2 });
    expect(knowledge.read(runId, original).summary).toBe('The contract is declared in source.ts.');
    expect(knowledge.search(runId).items.map(item => item.revision)).toEqual([1, 2]);
  });

  it('persists the exploration decision version and rejects automatic adoption after that decision changes', async () => {
    const { knowledge, observe, result, runId, app } = setup();
    const prepared = knowledge.prepare(runId, result([await observe()]));
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, decisionVersion: 1 });
    app.store.updateRun(runId, { decisionVersion: 1 });
    const ref = knowledge.persist(prepared);
    const page = knowledge.read(runId, ref);
    expect(page).toMatchObject({ freshness: 'current', decisionStale: true });
    expect(JSON.parse(page.text).source_decision_version).toBe(0);
    expect(() => knowledge.validateUse(runId, ref)).toThrow('superseded decision');
  });

  it('accepts current-decision re-reads from an older dispatched exploration while keeping its original provenance', async () => {
    const { knowledge, observe, result, runId, app } = setup();
    const previousEvidence = await observe();
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, decisionVersion: 1 });
    app.store.updateRun(runId, { decisionVersion: 1 });
    expect(() => knowledge.prepare(runId, result([previousEvidence]))).toThrow('current exploration run decision version');
    const currentEvidence = await observe();
    app.store.putCall({ ...app.store.call(currentEvidence), decisionVersion: 1 });
    const ref = knowledge.persist(knowledge.prepare(runId, result([currentEvidence])));
    const page = knowledge.read(runId, ref);
    expect(page).toMatchObject({ freshness: 'current', decisionStale: true });
    expect(JSON.parse(page.text).source_decision_version).toBe(0);
    expect(() => knowledge.validateUse(runId, ref)).toThrow('superseded decision');
  });

  it('caps search at five summaries and supports stable bounded reads and path filtering', async () => {
    const { knowledge, observe, result, runId, nextRun } = setup();
    const evidence = await observe();
    let ref = knowledge.persist(knowledge.prepare(runId, result([evidence])));
    for (let index = 0; index < 6; index++) {
      const owner = nextRun();
      ref = knowledge.persist(knowledge.prepare(owner, result([await observe('source.ts', owner)])));
    }
    const first = knowledge.search(runId, { query: 'CONTRACT', paths: ['source.ts'] });
    expect(first.items).toHaveLength(5);
    expect(first.next).not.toBeNull();
    expect(knowledge.search(runId, { after: first.next! }).items).toHaveLength(2);
    expect(knowledge.search(runId, { paths: ['unrelated'] }).items).toEqual([]);
    expect(() => knowledge.search(runId, { limit: 6 })).toThrow('limit 1-5');
    const full = knowledge.read(runId, ref);
    let page = knowledge.read(runId, { ...ref, maxChars: 256 });
    let joined = page.text;
    while (page.next) { page = knowledge.read(runId, page.next); joined += page.text; }
    expect(joined).toBe(full.text);
    expect(() => knowledge.read(runId, { ...ref, offset: full.totalChars + 1 })).toThrow('character boundary');
  });

  it('rolls back knowledge and its events together with run completion', async () => {
    const { knowledge, observe, result, runId, app } = setup();
    const prepared = knowledge.prepare(runId, result([await observe()]));
    expect(() => app.store.transaction(() => {
      knowledge.persist(prepared);
      app.store.updateRun(runId, { status: 'completed' });
      throw new Error('abort completion');
    })).toThrow('abort completion');
    expect(knowledge.search(runId).items).toEqual([]);
    expect(app.store.run(runId).status).toBe('queued');
    expect(app.store.events(runId).some(event => event.type === 'knowledge.saved')).toBe(false);
    expect(knowledge.persist(prepared)).toEqual({ id: 'contract', revision: 1 });
  });

  it('retains independent excerpts through session cleanup and GC without retaining raw source tool blobs', async () => {
    const { knowledge, observe, result, runId, app, root, nextRun } = setup();
    const sourceText = `${'context '.repeat(650)}\nexport const lateEvidence = 'required after source session cleanup';\n`;
    writeFileSync(path.join(root, 'source.ts'), sourceText);
    const evidence = await observe();
    const call = app.store.call(evidence);
    const ref = knowledge.persist(knowledge.prepare(runId, result([evidence])));
    const requester = nextRun();
    app.store.updateRun(runId, { status: 'completed' });
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, createdAt: '2000-01-01T00:00:00.000Z' });
    storageTestConnection(app.store).prepare('UPDATE events SET time=? WHERE session_id=?').run('2000-01-01T00:00:00.000Z', session.id);
    expect(app.store.gc({ olderThanDays: 1 }).removedSessions).toBe(1);
    expect(app.store.hasBlob(call.resultRef!)).toBe(false);
    const page = knowledge.read(requester, ref);
    expect(page).toMatchObject({ sourceAvailable: false, freshness: 'current' });
    expect(JSON.parse(page.text).evidence[0].snippet).toBe(readFileSync(path.join(root, 'source.ts'), 'utf8'));
    expect(JSON.parse(page.text).evidence[0].snippet).toContain('lateEvidence');
    expect(page.text).not.toContain(evidence);
    expect(page.text).not.toContain(session.id);
    expect(page.text).not.toContain('source_run_id');
  });

  it('checks both real and lexical evidence paths against a proposed child scope before disclosing excerpts', async () => {
    const { knowledge, observe, result, runId, app, root } = setup();
    mkdirSync(path.join(root, 'src'));
    mkdirSync(path.join(root, 'private'));
    writeFileSync(path.join(root, 'private', 'contract.ts'), 'private contract');
    symlinkSync(path.join(root, 'private'), path.join(root, 'src', 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const ref = knowledge.persist(knowledge.prepare(runId, result([await observe('src/alias/contract.ts')])));
    expect(knowledge.validateUse(runId, ref).freshness).toBe('current');
    expect(() => knowledge.validateFor({ ...app.store.run(runId), scope: { read: ['src'] } }, ref)).toThrow('native file authorization');
    expect(() => knowledge.validateFor({ ...app.store.run(runId), permissions: [] }, ref)).toThrow('read permission');
  });

  it('removes unbound session-only findings with their source session instead of retaining them as project assets', () => {
    const { knowledge, result, runId, app, nextRun } = setup();
    knowledge.persist(knowledge.prepare(runId, result([], { open_questions: ['The required inputs were unavailable.'] })));
    nextRun();
    app.store.updateRun(runId, { status: 'completed' });
    const session = app.store.session(app.store.run(runId).sessionId);
    app.store.putSession({ ...session, createdAt: '2000-01-01T00:00:00.000Z' });
    storageTestConnection(app.store).prepare('UPDATE events SET time=? WHERE session_id=?').run('2000-01-01T00:00:00.000Z', session.id);
    expect(app.store.gc({ olderThanDays: 1 }).removedSessions).toBe(1);
    expect(storageTestConnection(app.store).prepare('SELECT COUNT(*) AS count FROM knowledge_versions').get()).toEqual({ count: 0 });
  });

  it('lets the trusted host clear a project and makes its unreferenced retained excerpts collectible', async () => {
    const { knowledge, observe, result, runId, app } = setup();
    const ref = knowledge.persist(knowledge.prepare(runId, result([await observe()])));
    const bodyRef = (storageTestConnection(app.store).prepare('SELECT body_ref FROM knowledge_versions').get() as { body_ref: string }).body_ref;
    knowledge.adopt(runId, [{ ...ref, purpose: 'inspect cleanup' }]);
    expect(knowledge.clearProject(runId)).toEqual({ removedVersions: 1 });
    expect(knowledge.search(runId).items).toEqual([]);
    app.store.gc();
    expect(app.store.hasBlob(bodyRef)).toBe(false);
  });

  it('hides a stored observation if a source alias is redirected outside native scope', async () => {
    const { knowledge, observe, result, runId, app, root } = setup();
    const alias = path.join(root, 'alias');
    const source = path.join(root, 'allowed');
    mkdirSync(source);
    writeFileSync(path.join(source, 'source.ts'), 'allowed contract');
    symlinkSync(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const ref = knowledge.persist(knowledge.prepare(runId, result([await observe('alias/source.ts')])));
    app.store.updateRun(runId, { scope: { read: ['allowed'] } });
    expect(knowledge.read(runId, ref).freshness).toBe('current');
    unlinkSync(alias);
    const outside = temp();
    writeFileSync(path.join(outside, 'source.ts'), 'allowed contract');
    symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(knowledge.search(runId).items).toEqual([]);
    expect(() => knowledge.read(runId, ref)).toThrow('not available');
  });

  it('provides native read-only host tools with bounded schemas', () => {
    const { knowledge } = setup();
    const tools = knowledgeTools(knowledge);
    expect(tools.map(tool => [tool.name, tool.permission, tool.effect])).toEqual([['knowledge.browse', 'read', 'read'], ['knowledge.search', 'read', 'read'], ['knowledge.read', 'read', 'read']]);
  });

  it('organizes a shallow directory without rewriting immutable knowledge revisions', async () => {
    const { knowledge, observe, result, runId } = setup();
    const ref = knowledge.persist(knowledge.prepare(runId, result([await observe()])));
    expect(knowledge.browse(runId).items.map(item => item.id)).toContain('unclassified');
    const folder = knowledge.createFolder(runId, 'Protocols');
    const entry = knowledge.organize(runId, { knowledgeId: ref.id, parentId: folder.id });
    expect(entry).toMatchObject({ kind: 'entry', parentId: folder.id, knowledgeId: ref.id });
    const page = knowledge.browse(runId, { parentId: folder.id });
    expect(page.items).toEqual([expect.objectContaining({
      id: entry.id, knowledgeId: ref.id,
      knowledge: expect.objectContaining({ id: ref.id, revision: ref.revision }),
    })]);
    expect(() => knowledge.removeFolder(runId, folder.id)).toThrow('move all children');
    expect(knowledge.organize(runId, { nodeId: entry.id, title: 'Renamed contract' }).title).toBe('Renamed contract');
    knowledge.organize(runId, { nodeId: entry.id, parentId: null });
    knowledge.removeFolder(runId, folder.id);
    expect(knowledge.browse(runId, { parentId: folder.id }).items).toEqual([]);
    expect(knowledge.read(runId, ref).summary).toBe('The contract is declared in source.ts.');
  });
});
