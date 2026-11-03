import { effectiveMethodRun } from '../extensions/methods.js';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, readFileSync, realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { canAccessFileScope, normalizeFileScope } from '../runtime/scope.js';
import { KodoError } from '../runtime/types.js';
import type { FileScope, Run, ToolRequest } from '../runtime/types.js';
import { Store, digest } from '../storage/index.js';
import type { Page } from '../storage/index.js';

export interface KnowledgeRef { id: string; revision: number }
export interface KnowledgeUse extends KnowledgeRef { purpose: string }
export type KnowledgeFreshness = 'current' | 'stale' | 'unknown';
interface Claim { text: string; basis: 'source_observation'; evidence_ids: string[] }
interface ExplorationResult { question_id: string; summary: string; claims: Claim[]; hypotheses: string[]; open_questions: string[] }
interface Evidence { id: string; sourceCallId: string; path: string; resolvedPath: string; sha256: string; snippet: string; offset: number; contentOffset: number }
interface KnowledgeBody extends KnowledgeRef {
  schema_version: 1; project_id: string; question: string; summary: string; scope: string[];
  claims: Claim[]; hypotheses: string[]; open_questions: string[]; evidence: Evidence[];
  dependencies: { path: string; resolvedPath: string; sha256: string }[];
  source_run_id: string; source_session_id: string; source_decision_version: number;
  created_at: string; confirmation: 'candidate'; snapshot: 'consistent' | 'uncertain';
}
export interface KnowledgeSummary extends KnowledgeRef {
  summary: string; scope: string[]; freshness: KnowledgeFreshness; confirmation: 'candidate';
  completeness: 'partial' | 'answered'; sourceAvailable: boolean;
  decisionStale: boolean;
  read?: { tool: 'knowledge.read'; args: KnowledgeRef };
}
export interface PreparedKnowledge { readonly runId: string; readonly projectId: string; readonly id: string }
export interface KnowledgeSearch { query?: string; paths?: string[]; after?: number; limit?: number; in?: 'summary' | 'evidence' }
export interface KnowledgeRead extends KnowledgeRef { offset?: number; maxChars?: number; evidenceId?: string }
export interface KnowledgeNode { id: string; parentId: string | null; kind: 'folder' | 'entry'; title: string; knowledgeId: string | null }
export interface KnowledgeBrowse { parentId?: string; after?: string; limit?: number }
export interface KnowledgePage extends KnowledgeSummary {
  text: string; offset: number; totalChars: number; complete: boolean; next: KnowledgeRead | null;
  note: string;
}
interface Project { id: string; workspace: string }
const protectedPart = (part: string): boolean => /^(?:\.git|\.kodo|\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx))$/i.test(part);
const comparable = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
const inside = (root: string, target: string): boolean => {
  const relative = path.relative(comparable(root), comparable(target));
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const malformed = (message: string): never => { throw new KodoError('KNOWLEDGE_RESULT', message); };
function boundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) return malformed(`${field} must be nonempty text no longer than ${maximum} characters`);
  return value;
}
function texts(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length > 30) return malformed(`${field} must be an array of at most 30 strings`);
  return value.map(item => boundedText(item, field, 2000));
}
function parseResult(text: string, questionId: string): ExplorationResult {
  if (typeof text !== 'string' || text.length > 64_000) return malformed('exploration result exceeds 64000 characters');
  let value: unknown;
  try { value = JSON.parse(text); } catch { return malformed('exploration completion must be a JSON object'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed('exploration completion must be a JSON object');
  const source = value as Record<string, unknown>;
  const keys = ['question_id', 'summary', 'claims', 'hypotheses', 'open_questions'];
  if (Object.keys(source).some(key => !keys.includes(key)) || keys.some(key => !(key in source))) return malformed('use only question_id, summary, claims, hypotheses and open_questions');
  if (source.question_id !== questionId) return malformed('question_id must match the host-assigned exploration question');
  if (!Array.isArray(source.claims) || source.claims.length > 30) return malformed('claims must be an array of at most 30 source observations');
  const claims = source.claims.map((value: unknown): Claim => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return malformed('each claim must be an object');
    const claim = value as Record<string, unknown>;
    if (Object.keys(claim).some(key => !['text', 'basis', 'evidence_ids'].includes(key)) || claim.basis !== 'source_observation') return malformed('only source_observation claims are supported; searches, execution, absence and exhaustive scope assertions are not verified facts');
    const ids = texts(claim.evidence_ids, 'evidence_ids');
    if (!ids.length) return malformed('each source observation needs at least one successful file.read call ID');
    return { text: boundedText(claim.text, 'claim text', 2000), basis: 'source_observation', evidence_ids: [...new Set(ids)] };
  });
  const openQuestions = texts(source.open_questions, 'open_questions');
  if (!claims.length && !openQuestions.length) return malformed('a result without source observations must name its unresolved questions');
  return { question_id: questionId, summary: boundedText(source.summary, 'summary', 2000), claims, hypotheses: texts(source.hypotheses, 'hypotheses'), open_questions: openQuestions };
}
function actualPath(target: string): string {
  const missing: string[] = [];
  let cursor = target;
  for (;;) {
    try { return path.join(realpathSync(cursor), ...missing.reverse()); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor)); cursor = parent;
    }
  }
}

/** Host-owned project identity and immutable, explicitly unconfirmed source observations. */
export class ProjectKnowledge {
  private readonly ownerId: string;
  private readonly prepared = new WeakMap<PreparedKnowledge, KnowledgeBody>();
  constructor(private readonly store: Store, options: { ownerId?: string } = {}) {
    this.ownerId = options.ownerId ?? userInfo().username;
    if (typeof this.ownerId !== 'string' || !this.ownerId.trim() || this.ownerId.length > 1000) throw new KodoError('KNOWLEDGE_OWNER', 'host ownerId must be nonempty text of at most 1000 characters');
  }

  /** No database changes: callers can validate before atomically completing a run. */
  prepare(runId: string, finalText: string, observationId?: string): PreparedKnowledge {
    const run = effectiveMethodRun(this.store, this.store.run(runId));
    // 1d removed the exploration run field. Older records may still carry it; new
    // observations name their identity explicitly or through the published JSON.
    const exploration = (run as Run & { exploration?: { questionId: string; decisionVersion?: number } }).exploration;
    let questionId = observationId ?? exploration?.questionId;
    if (!questionId) {
      let candidate: unknown;
      try { candidate = JSON.parse(finalText); }
      catch { throw new KodoError('KNOWLEDGE_RESULT', 'exploration completion must be a JSON object'); }
      const id = (candidate as { question_id?: unknown } | null)?.question_id;
      if (typeof id === 'string') questionId = id;
    }
    if (!questionId) throw new KodoError('KNOWLEDGE_RESULT', 'project observations need an explicit identity');
    const result = parseResult(finalText, questionId);
    const project = this.project(runId);
    const evidence: Evidence[] = [];
    const evidenceIds = new Map<string, string>();
    const sourceIds = new Set(result.claims.flatMap(claim => claim.evidence_ids));
    if (sourceIds.size > 30) return malformed('one knowledge entry supports at most 30 source excerpts');
    for (const callId of sourceIds) {
      let call;
      try { call = this.store.call(callId); } catch { return malformed('evidence must reference an existing successful file.read call from this exploration'); }
      if (call.runId !== runId || call.kind !== 'tool' || call.name !== 'file.read' || call.status !== 'succeeded' || call.effect !== 'read' || !call.resultRef || (call.evidencePermission !== undefined && call.evidencePermission !== 'read')) return malformed('evidence must reference a successful file.read call from this exploration');
      if ((call.decisionVersion ?? 0) !== (run.decisionVersion ?? 0)) return malformed('evidence must belong to the current exploration run decision version');
      const request = this.store.readBlob<ToolRequest>(call.requestRef);
      let args: { path?: unknown };
      try { args = JSON.parse(request.arguments) as typeof args; } catch { return malformed('file.read evidence request is malformed'); }
      if (typeof args?.path !== 'string') return malformed('file.read evidence needs a runtime-recorded source path');
      const source = this.sourcePath(runId, args.path);
      const value = this.store.readBlob<{ content?: unknown; hash?: unknown; offset?: number; contentOffset?: number }>(call.resultRef);
      if (typeof value.content !== 'string' || value.content.length > 32_000 || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.hash)) return malformed('file.read evidence needs runtime-recorded bounded content and whole-file SHA-256');
      const id = `evidence-${evidence.length + 1}`;
      evidenceIds.set(callId, id);
      evidence.push({ id, sourceCallId: callId, path: source.relative, resolvedPath: path.relative(project.workspace, source.resolved).replaceAll('\\', '/'), sha256: value.hash, snippet: value.content, offset: value.offset ?? 1, contentOffset: value.contentOffset ?? 0 });
    }
    const dependencies = [...new Map(evidence.map(item => [`${item.path}:${item.sha256}`, { path: item.path, resolvedPath: item.resolvedPath, sha256: item.sha256 }])).values()];
    if (JSON.stringify(dependencies.map(source => source.path)).length > 4096) return malformed('knowledge source paths exceed the bounded summary limit');
    const body: KnowledgeBody = {
      schema_version: 1, id: result.question_id, revision: 0, project_id: project.id, question: run.objective,
      summary: result.summary, scope: [...new Set(evidence.map(item => item.path))],
      claims: result.claims.map(claim => ({ ...claim, evidence_ids: claim.evidence_ids.map(id => evidenceIds.get(id)!) })),
      hypotheses: result.hypotheses, open_questions: result.open_questions, evidence, dependencies,
      source_run_id: runId, source_session_id: run.sessionId, source_decision_version: exploration?.decisionVersion ?? run.decisionVersion ?? 0,
      created_at: new Date().toISOString(), confirmation: 'candidate', snapshot: 'consistent',
    };
    if (this.freshness(runId, body) !== 'current') body.snapshot = 'uncertain';
    const prepared = Object.freeze({ runId, projectId: project.id, id: body.id });
    this.prepared.set(prepared, body);
    return prepared;
  }

  /** The enclosing Store transaction may include run completion and its event. */
  persist(prepared: PreparedKnowledge): KnowledgeRef {
    const source = this.prepared.get(prepared);
    if (!source || this.project(prepared.runId).id !== prepared.projectId) throw new KodoError('KNOWLEDGE_PREPARED', 'persist requires a prepared result from this knowledge service');
    if (this.freshness(prepared.runId, source) !== 'current') source.snapshot = 'uncertain';
    return this.store.transaction(() => {
      const existing = this.store.knowledge.refBySourceRun(source.project_id, source.source_run_id);
      if (existing) {
        const previous = this.store.readBlob<KnowledgeBody>(existing);
        const comparableBody = (body: KnowledgeBody): string => JSON.stringify({ ...body, revision: 0, created_at: '', snapshot: '' });
        if (comparableBody(previous) !== comparableBody(source)) throw new KodoError('KNOWLEDGE_CONFLICT', 'this exploration already saved a different immutable result');
        return { id: previous.id, revision: previous.revision };
      }
      const project = this.project(prepared.runId);
      this.store.knowledge.ensureProject(project.id, this.ownerId, project.workspace);
      const body = { ...source, revision: this.store.knowledge.maxRevision(project.id, source.id) + 1 };
      const ref = this.store.blob(body);
      this.store.knowledge.insertVersion({ projectId: project.id, id: body.id, revision: body.revision, sourceRunId: body.source_run_id, bodyRef: ref, data: JSON.stringify({ summary: body.summary, scope: body.scope }) });
      const summary = this.summary(prepared.runId, body);
      this.store.event(prepared.runId, 'knowledge.saved', { id: body.id, revision: body.revision, questionId: body.id, sourceDecisionVersion: body.source_decision_version, freshness: summary.freshness, completeness: summary.completeness });
      return { id: body.id, revision: body.revision };
    });
  }

  search(runId: string, options: KnowledgeSearch = {}): Page<KnowledgeSummary> {
    const project = this.project(runId);
    const { after = 0, limit = 5, query = '', paths = [] } = options;
    if (options.in !== undefined && !['summary', 'evidence'].includes(options.in)) throw new KodoError('KNOWLEDGE_PAGE', 'in must be summary or evidence');
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 5 || typeof query !== 'string' || query.length > 1000 || !Array.isArray(paths) || paths.length > 30) throw new KodoError('KNOWLEDGE_PAGE', 'search requires after >= 0, limit 1-5 and bounded query/path lists');
    const roots = normalizeFileScope({ read: paths }).read!;
    const rows = this.store.knowledge.versionsAfter(project.id, after);
    const found: { seq: number; item: KnowledgeSummary }[] = [];
    for (const row of rows) {
      const body = this.store.readBlob<KnowledgeBody>(row.body_ref);
      if (!this.visible(runId, body)) continue;
      const title = this.store.knowledge.nodeTitle(project.id, body.id);
      const searchable = options.in === 'evidence' ? body.evidence.map(item => `${item.path}\n${item.snippet}`).join('\n') : `${body.id}\n${body.question}\n${title ?? ''}\n${body.summary}\n${body.scope.join('\n')}`;
      if (query && !searchable.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
      if (roots.length && !body.scope.some(source => roots.some(root => inside(path.resolve(project.workspace, root), path.resolve(project.workspace, source))))) continue;
      found.push({ seq: row.seq, item: this.summary(runId, body) });
      if (found.length > limit) break;
    }
    const items = found.slice(0, limit);
    return { items: items.map(item => item.item), next: found.length > limit ? items.at(-1)!.seq : null };
  }

  /** Only branches with visible knowledge are disclosed. Old entries remain virtual until organized. */
  browse(runId: string, options: KnowledgeBrowse = {}, includeEmptyFolders = false): { items: (KnowledgeNode & { knowledge?: KnowledgeSummary; adoptedRevisions?: number[] })[]; next: string | null } {
    const project = this.project(runId);
    const { parentId, after = '', limit = 5 } = options;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 || typeof after !== 'string' || after.length > 512) throw new KodoError('KNOWLEDGE_PAGE', 'browse requires a bounded cursor and limit 1-20');
    const nodes = this.nodes(project.id);
    for (const node of nodes) if (node.kind === 'entry' && !node.parentId) node.parentId = 'unclassified';
    const latest = new Map<string, KnowledgeBody>();
    for (const ref of this.store.knowledge.projectRefs(project.id)) {
      const body = this.store.readBlob<KnowledgeBody>(ref);
      if (this.visible(runId, body)) latest.set(body.id, body);
    }
    for (const body of latest.values()) if (!nodes.some(node => node.knowledgeId === body.id)) nodes.push({ id: this.entryId(body.id), parentId: 'unclassified', kind: 'entry', title: body.question.slice(0, 160), knowledgeId: body.id });
    if (nodes.some(node => node.parentId === 'unclassified')) nodes.push({ id: 'unclassified', parentId: null, kind: 'folder', title: '未分类', knowledgeId: null });
    const visible = (node: KnowledgeNode, seen = new Set<string>()): boolean => {
      if (seen.has(node.id)) return false;
      seen.add(node.id);
      return node.kind === 'entry' ? latest.has(node.knowledgeId!) : (includeEmptyFolders && !nodes.some(child => child.parentId === node.id)) || nodes.some(child => child.parentId === node.id && visible(child, new Set(seen)));
    };
    if (parentId && !nodes.some(node => node.id === parentId && node.kind === 'folder' && visible(node))) return { items: [], next: null };
    const candidates = nodes.filter(node => node.parentId === (parentId ?? null) && visible(node) && node.id > after).sort((a, b) => a.id < b.id ? -1 : 1);
    const items = candidates.slice(0, limit).map(node => {
      const body = node.knowledgeId ? latest.get(node.knowledgeId) : undefined;
      const adopted = body ? this.store.knowledge.adoptedRevisions(project.id, body.id, runId) : [];
      return { ...node, ...(body ? { knowledge: this.summary(runId, body), adoptedRevisions: adopted } : {}) };
    });
    return { items, next: candidates.length > limit ? items.at(-1)!.id : null };
  }

  /** Trusted host edits metadata only; models retain read-only knowledge tools. */
  createFolder(runId: string, title: string, parentId: string | null = null): KnowledgeNode {
    const project = this.project(runId);
    return this.store.transaction(() => {
      this.store.knowledge.ensureProject(project.id, this.ownerId, project.workspace);
      const node: KnowledgeNode = { id: `folder-${randomUUID()}`, parentId, kind: 'folder', title: boundedText(title, 'title', 160), knowledgeId: null };
      if (parentId) this.assertFolderVisible(runId, project.id, parentId);
      this.validatePlacement(project.id, node); this.writeNode(project.id, node); return node;
    });
  }
  organize(runId: string, input: { nodeId?: string; knowledgeId?: string; title?: string; parentId?: string | null }): KnowledgeNode {
    const project = this.project(runId);
    return this.store.transaction(() => {
      let node = this.nodes(project.id).find(node => input.nodeId ? node.id === input.nodeId : node.knowledgeId === input.knowledgeId);
      if (node?.kind === 'entry' || (!node && input.knowledgeId)) {
        const id = node?.knowledgeId ?? input.knowledgeId!;
        const body = this.store.knowledge.refsOf(project.id, id).map(ref => this.store.readBlob<KnowledgeBody>(ref)).find(body => this.visible(runId, body));
        if (!body) throw new KodoError('KNOWLEDGE_NOT_FOUND', 'knowledge is not available in the current project scope');
        node ??= { id: this.entryId(id), parentId: null, kind: 'entry', title: body.question.slice(0, 160), knowledgeId: id };
      }
      if (!node) throw new KodoError('KNOWLEDGE_NODE', 'node is not in this project');
      if (node.kind === 'folder') this.assertFolderVisible(runId, project.id, node.id);
      const changed = { ...node, ...(input.title !== undefined ? { title: boundedText(input.title, 'title', 160) } : {}), ...(input.parentId !== undefined ? { parentId: input.parentId } : {}) };
      if (changed.parentId) this.assertFolderVisible(runId, project.id, changed.parentId);
      this.validatePlacement(project.id, changed); this.writeNode(project.id, changed); return changed;
    });
  }
  removeFolder(runId: string, nodeId: string): void {
    const project = this.project(runId);
    this.store.transaction(() => {
      if (!this.nodes(project.id).some(node => node.id === nodeId && node.kind === 'folder')) throw new KodoError('KNOWLEDGE_NODE', 'folder is not in this project');
      if (this.nodes(project.id).some(child => child.parentId === nodeId)) throw new KodoError('KNOWLEDGE_NODE', 'move all children before deleting a folder');
      this.store.knowledge.deleteNode(project.id, nodeId);
    });
  }
  versions(runId: string, id: string, after = 0): Page<KnowledgeSummary> {
    const project = this.project(runId);
    if (typeof id !== 'string' || id.length > 256 || !Number.isSafeInteger(after) || after < 0) throw new KodoError('KNOWLEDGE_REF', 'versions require a knowledge ID and nonnegative revision cursor');
    const found: KnowledgeSummary[] = [];
    for (const ref of this.store.knowledge.refsAfter(project.id, id, after)) {
      const body = this.store.readBlob<KnowledgeBody>(ref);
      if (this.visible(runId, body)) found.push(this.summary(runId, body));
      if (found.length > 5) break;
    }
    return { items: found.slice(0, 5), next: found.length > 5 ? found[4]!.revision : null };
  }
  private entryId(id: string): string { return `entry-${digest(id)}`; }
  private nodes(projectId: string): KnowledgeNode[] { return this.store.knowledge.nodes(projectId); }
  private writeNode(projectId: string, node: KnowledgeNode): void {
    this.store.knowledge.writeNode(projectId, node);
  }
  private validatePlacement(projectId: string, candidate: KnowledgeNode): void {
    const nodes = [...this.nodes(projectId).filter(node => node.id !== candidate.id), candidate];
    for (const node of nodes) {
      const seen = new Set([node.id]); let parentId = node.parentId; let folders = node.kind === 'folder' ? 1 : 0;
      while (parentId) {
        const parent = nodes.find(node => node.id === parentId && node.kind === 'folder');
        if (!parent || seen.has(parentId)) throw new KodoError('KNOWLEDGE_NODE', 'parent must be a folder in this project without cycles');
        seen.add(parentId); folders++; parentId = parent.parentId;
      }
      if (folders > 2) throw new KodoError('KNOWLEDGE_NODE', 'knowledge supports at most two folder levels');
    }
  }
  private assertFolderVisible(runId: string, projectId: string, id: string): void {
    for (const child of this.nodes(projectId).filter(node => node.parentId === id)) {
      if (child.kind === 'folder') this.assertFolderVisible(runId, projectId, child.id);
      else {
        if (!(child.knowledgeId ? this.store.knowledge.refsOf(projectId, child.knowledgeId) : []).some(ref => this.visible(runId, this.store.readBlob<KnowledgeBody>(ref)))) throw new KodoError('KNOWLEDGE_DENIED', 'folder contains unavailable knowledge');
      }
    }
  }

  read(runId: string, options: KnowledgeRead): KnowledgePage {
    const body = this.load(runId, options);
    const { offset = 0, maxChars = 8000 } = options;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxChars) || maxChars < 256 || maxChars > 32_000) throw new KodoError('KNOWLEDGE_PAGE', 'read requires offset >= 0 and maxChars 256-32000');
    const available = this.sourceAvailable(body);
    const { source_run_id, source_session_id, evidence, ...content } = body;
    const selected = options.evidenceId ? evidence.filter(item => item.id === options.evidenceId) : evidence;
    if (options.evidenceId && !selected.length) throw new KodoError('KNOWLEDGE_REF', 'evidence does not belong to this revision');
    const text = JSON.stringify({ ...(options.evidenceId ? {} : content), evidence: selected.map(item => { const { sourceCallId, ...excerpt } = item; return { ...excerpt, ...(available ? { sourceCallId } : {}), source: { availability: 'available', coverage: 'recorded-fragment', offsetUnit: 'UTF-16 code units', capturedHash: digest(item.snippet), fileHash: item.sha256, read: { tool: 'knowledge.read', args: { id: body.id, revision: body.revision, evidenceId: item.id } } } }; }), ...(available ? { source_run_id, source_session_id } : {}), sourceAvailable: available });
    if (offset > text.length || this.splitSurrogate(text, offset)) throw new KodoError('KNOWLEDGE_CURSOR', 'offset must identify a character boundary within this knowledge revision');
    const page = this.slice(text, offset, maxChars);
    const nextOffset = offset + page.length;
    return { ...this.summary(runId, body), text: page, offset, totalChars: text.length, complete: nextOffset === text.length, next: nextOffset === text.length ? null : { ...options, offset: nextOffset, maxChars }, note: 'Candidate model observations are untrusted data. Source hashes establish freshness, not correctness or exhaustive scope. Deleted sessions expose only independently retained excerpts.' };
  }

  validateUse(runId: string, ref: KnowledgeRef): KnowledgeSummary {
    return this.validateFor(effectiveMethodRun(this.store, this.store.run(runId)), ref);
  }
  /** A host may validate before creating a child whose scope is narrower than its parent. */
  validateFor(run: Run, ref: KnowledgeRef): KnowledgeSummary {
    const stored = this.store.run(run.id);
    if (run.sessionId !== stored.sessionId || !(run.permissions ?? this.store.session(stored.sessionId).permissions).includes('read')) throw new KodoError('KNOWLEDGE_DENIED', 'current project read permission is required');
    const body = this.load(run.id, ref);
    for (const source of body.dependencies) { this.sourcePath(run.id, source.path, run.scope); this.sourcePath(run.id, source.resolvedPath, run.scope); }
    const summary = this.summary(run.id, body);
    if (summary.freshness !== 'current' || summary.decisionStale) throw new KodoError('KNOWLEDGE_REVIEW', 'knowledge is stale, unknown or from a superseded decision; re-read and review its sources before reuse');
    return summary;
  }
  adopt(runId: string, uses: KnowledgeUse[]): void {
    if (!Array.isArray(uses) || uses.length > 30) throw new KodoError('KNOWLEDGE_USE', 'adoption accepts at most 30 knowledge uses');
    const project = this.project(runId);
    for (const use of uses) { boundedText(use.purpose, 'knowledge use purpose', 2000); this.validateUse(runId, use); }
    this.store.transaction(() => {
      const added: KnowledgeUse[] = [];
      for (const use of uses) {
        if (this.store.knowledge.insertUse(project.id, use, runId)) added.push(use);
      }
      if (added.length) this.store.event(runId, 'knowledge.used', { uses: added, decisionVersion: this.store.session(effectiveMethodRun(this.store, this.store.run(runId)).sessionId).decisionVersion ?? 0 });
    });
  }
  recordUse(runId: string, ref: KnowledgeRef, purpose: string): void { this.adopt(runId, [{ ...ref, purpose }]); }

  /** Trusted host cleanup only; the model tool registrations expose search/read exclusively. */
  clearProject(runId: string): { removedVersions: number } {
    const project = this.project(runId);
    return this.store.transaction(() => ({ removedVersions: this.store.knowledge.clearProject(project.id) }));
  }

  private project(runId: string): Project {
    const run = effectiveMethodRun(this.store, this.store.run(runId));
    const session = this.store.session(run.sessionId);
    if (!session.permissions.includes('read') || !(run.permissions ?? session.permissions).includes('read')) throw new KodoError('KNOWLEDGE_DENIED', 'current project read permission is required');
    const workspace = realpathSync(session.workspace);
    return { id: digest(JSON.stringify([this.ownerId, comparable(workspace)])), workspace };
  }
  private sourcePath(runId: string, input: string, scopeOverride?: FileScope): { relative: string; resolved: string } {
    const project = this.project(runId);
    if (typeof input !== 'string' || !input || input.includes('\0') || input.includes(':') || input.startsWith('\\') || path.isAbsolute(input)) throw new KodoError('KNOWLEDGE_DENIED', 'knowledge sources must be relative workspace files');
    const parts = input.replaceAll('\\', '/').split('/');
    if (parts.some(part => part === '..' || protectedPart(part))) throw new KodoError('KNOWLEDGE_DENIED', 'knowledge source contains protected data');
    const lexical = path.resolve(project.workspace, input);
    const resolved = actualPath(lexical);
    if (!inside(project.workspace, resolved) || inside(this.store.directory, resolved) || path.relative(project.workspace, resolved).split(path.sep).some(protectedPart) || !canAccessFileScope(effectiveMethodRun(this.store, this.store.run(runId)).scope, 'read', project.workspace, resolved) || !canAccessFileScope(scopeOverride, 'read', project.workspace, resolved)) throw new KodoError('KNOWLEDGE_DENIED', 'knowledge source is outside the current native file authorization');
    return { relative: path.relative(project.workspace, lexical).replaceAll('\\', '/'), resolved };
  }
  private visible(runId: string, body: KnowledgeBody): boolean {
    try {
      if (body.project_id !== this.project(runId).id) return false;
      if (!body.dependencies.length && body.source_session_id !== effectiveMethodRun(this.store, this.store.run(runId)).sessionId) return false;
      for (const source of body.dependencies) {
        const current = this.sourcePath(runId, source.path);
        this.sourcePath(runId, source.resolvedPath);
        try { accessSync(current.resolved, constants.R_OK); }
        catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
      }
      return true;
    } catch (error) {
      if ((error instanceof KodoError && error.code === 'KNOWLEDGE_DENIED') || ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
  }
  private freshness(runId: string, body: KnowledgeBody): KnowledgeFreshness {
    if (!this.visible(runId, body)) throw new KodoError('KNOWLEDGE_DENIED', 'knowledge revision is not available in the current project scope');
    if (body.snapshot === 'uncertain' || !body.dependencies.length) return 'unknown';
    const project = this.project(runId);
    let stale = false;
    let unknown = false;
    for (const source of body.dependencies) {
      const file = this.sourcePath(runId, source.path).resolved;
      if (comparable(file) !== comparable(path.resolve(project.workspace, source.resolvedPath))) { stale = true; continue; }
      try {
        const info = statSync(file);
        if (!info.isFile() || info.size > 16 * 1024 * 1024) { unknown = true; continue; }
        const bytes = readFileSync(file);
        if (bytes.length > 16 * 1024 * 1024) { unknown = true; continue; }
        if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) stale = true;
      } catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) stale = true;
        else if (['EACCES', 'EPERM', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) unknown = true;
        else throw error;
      }
    }
    return stale ? 'stale' : unknown ? 'unknown' : 'current';
  }
  private load(runId: string, ref: KnowledgeRef): KnowledgeBody {
    if (!ref || typeof ref.id !== 'string' || !ref.id || ref.id.length > 256 || !Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new KodoError('KNOWLEDGE_REF', 'knowledge requires an ID and a positive immutable revision');
    const project = this.project(runId);
    const bodyRef = this.store.knowledge.ref(project.id, ref.id, ref.revision);
    if (!bodyRef) throw new KodoError('KNOWLEDGE_NOT_FOUND', 'knowledge revision is not available in the current project scope');
    const body = this.store.readBlob<KnowledgeBody>(bodyRef);
    if (!this.visible(runId, body)) throw new KodoError('KNOWLEDGE_NOT_FOUND', 'knowledge revision is not available in the current project scope');
    return body;
  }
  private summary(runId: string, body: KnowledgeBody): KnowledgeSummary {
    const requester = effectiveMethodRun(this.store, this.store.run(runId));
    return { id: body.id, revision: body.revision, read: { tool: 'knowledge.read', args: { id: body.id, revision: body.revision } }, summary: this.slice(body.summary, 0, 300), scope: body.scope, freshness: this.freshness(runId, body), confirmation: body.confirmation, completeness: body.open_questions.length || !body.claims.length ? 'partial' : 'answered', sourceAvailable: this.sourceAvailable(body), decisionStale: body.source_session_id === requester.sessionId && body.source_decision_version !== (this.store.session(requester.sessionId).decisionVersion ?? 0) };
  }
  private sourceAvailable(body: KnowledgeBody): boolean {
    return this.store.knowledge.sourceRetained(body.source_session_id, body.source_run_id);
  }
  private splitSurrogate(text: string, offset: number): boolean { return offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset] ?? ''); }
  private slice(text: string, offset: number, maximum: number): string {
    let end = Math.min(text.length, offset + maximum);
    if (this.splitSurrogate(text, end)) end--;
    return text.slice(offset, end);
  }
}
