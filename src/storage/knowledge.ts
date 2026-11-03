import type Database from 'better-sqlite3';

export interface KnowledgeVersionRow { seq: number; body_ref: string; data: string }
export interface KnowledgeNodeRow { id: string; parentId: string | null; kind: 'folder' | 'entry'; title: string; knowledgeId: string | null }
export interface KnowledgeVersionInsert { projectId: string; id: string; revision: number; sourceRunId: string; bodyRef: string; data: string }

/** Named queries over the knowledge tables; the knowledge service owns the semantics, this owns the SQL. */
export class KnowledgeRecords {
  constructor(private readonly db: Database.Database) {}
  counts(): { versions: number; uses: number } {
    return { versions: (this.db.prepare('SELECT count(*) AS count FROM knowledge_versions').get() as { count: number }).count, uses: (this.db.prepare('SELECT count(*) AS count FROM knowledge_uses').get() as { count: number }).count };
  }
  refsByRevision(id: string, revision: number): string[] { return (this.db.prepare('SELECT body_ref FROM knowledge_versions WHERE id=? AND revision=?').all(id, revision) as { body_ref: string }[]).map(row => row.body_ref); }

  ensureProject(id: string, ownerId: string, workspace: string): void {
    this.db.prepare('INSERT OR IGNORE INTO knowledge_projects(id,owner_id,workspace) VALUES (?,?,?)').run(id, ownerId, workspace);
  }
  /** Body reference saved by one source run, if that exploration already persisted. */
  refBySourceRun(projectId: string, sourceRunId: string): string | undefined {
    return (this.db.prepare('SELECT body_ref FROM knowledge_versions WHERE project_id=? AND source_run_id=?').get(projectId, sourceRunId) as { body_ref: string } | undefined)?.body_ref;
  }
  maxRevision(projectId: string, id: string): number {
    return (this.db.prepare('SELECT MAX(revision) AS revision FROM knowledge_versions WHERE project_id=? AND id=?').get(projectId, id) as { revision: number | null }).revision ?? 0;
  }
  insertVersion(row: KnowledgeVersionInsert): void {
    this.db.prepare('INSERT INTO knowledge_versions(project_id,id,revision,source_run_id,body_ref,data) VALUES (?,?,?,?,?,?)').run(row.projectId, row.id, row.revision, row.sourceRunId, row.bodyRef, row.data);
  }
  /** Project versions in insertion order after a cursor; iterated lazily so pages stop early. */
  versionsAfter(projectId: string, after: number): Iterable<KnowledgeVersionRow> {
    return this.db.prepare('SELECT seq,body_ref,data FROM knowledge_versions WHERE project_id=? AND seq>? ORDER BY seq').iterate(projectId, after) as Iterable<KnowledgeVersionRow>;
  }
  /** Every body reference of a project ordered by revision. */
  projectRefs(projectId: string): Iterable<string> {
    const rows = this.db.prepare('SELECT body_ref FROM knowledge_versions WHERE project_id=? ORDER BY revision').iterate(projectId) as Iterable<{ body_ref: string }>;
    return (function* () { for (const row of rows) yield row.body_ref; })();
  }
  /** Body references of one knowledge ID, newest revision first unless ascending is requested. */
  refsOf(projectId: string, id: string, order: 'ASC' | 'DESC' = 'DESC'): string[] {
    return (this.db.prepare(`SELECT body_ref FROM knowledge_versions WHERE project_id=? AND id=? ORDER BY revision ${order}`).all(projectId, id) as { body_ref: string }[]).map(row => row.body_ref);
  }
  refsAfter(projectId: string, id: string, after: number): Iterable<string> {
    const rows = this.db.prepare('SELECT body_ref FROM knowledge_versions WHERE project_id=? AND id=? AND revision>? ORDER BY revision').iterate(projectId, id, after) as Iterable<{ body_ref: string }>;
    return (function* () { for (const row of rows) yield row.body_ref; })();
  }
  ref(projectId: string, id: string, revision: number): string | undefined {
    return (this.db.prepare('SELECT body_ref FROM knowledge_versions WHERE project_id=? AND id=? AND revision=?').get(projectId, id, revision) as { body_ref: string } | undefined)?.body_ref;
  }
  nodeTitle(projectId: string, knowledgeId: string): string | undefined {
    return (this.db.prepare('SELECT title FROM knowledge_nodes WHERE project_id=? AND knowledge_id=?').get(projectId, knowledgeId) as { title: string } | undefined)?.title;
  }
  nodes(projectId: string): KnowledgeNodeRow[] {
    return this.db.prepare('SELECT id,parent_id AS parentId,kind,title,knowledge_id AS knowledgeId FROM knowledge_nodes WHERE project_id=?').all(projectId) as KnowledgeNodeRow[];
  }
  writeNode(projectId: string, node: KnowledgeNodeRow): void {
    this.db.prepare('INSERT INTO knowledge_nodes(project_id,id,parent_id,kind,title,knowledge_id) VALUES (?,?,?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET parent_id=excluded.parent_id,title=excluded.title').run(projectId, node.id, node.parentId, node.kind, node.title, node.knowledgeId);
  }
  deleteNode(projectId: string, id: string): void {
    this.db.prepare('DELETE FROM knowledge_nodes WHERE project_id=? AND id=?').run(projectId, id);
  }
  adoptedRevisions(projectId: string, id: string, runId: string): number[] {
    return (this.db.prepare('SELECT DISTINCT revision FROM knowledge_uses WHERE project_id=? AND id=? AND run_id=? ORDER BY revision').all(projectId, id, runId) as { revision: number }[]).map(row => row.revision);
  }
  /** Records one adoption; false when this run already adopted that revision. */
  insertUse(projectId: string, use: { id: string; revision: number; purpose: string }, runId: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO knowledge_uses(project_id,id,revision,run_id,purpose,time) VALUES (?,?,?,?,?,?)').run(projectId, use.id, use.revision, runId, use.purpose, new Date().toISOString()).changes > 0;
  }
  /** Adoptions recorded by one run in order, for the per-request state frame. */
  usesOf(runId: string): { id: string; revision: number; purpose: string }[] {
    return this.db.prepare('SELECT id,revision,purpose FROM knowledge_uses WHERE run_id=? ORDER BY seq').all(runId) as { id: string; revision: number; purpose: string }[];
  }
  /** Removes every record of a project and returns how many versions were deleted. */
  clearProject(projectId: string): number {
    this.db.prepare('DELETE FROM knowledge_uses WHERE project_id=?').run(projectId);
    this.db.prepare('DELETE FROM knowledge_nodes WHERE project_id=?').run(projectId);
    const removed = this.db.prepare('DELETE FROM knowledge_versions WHERE project_id=?').run(projectId);
    this.db.prepare('DELETE FROM knowledge_projects WHERE id=?').run(projectId);
    return removed.changes;
  }
  /** Whether a source run is still retained in its session. */
  sourceRetained(sessionId: string, runId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM sessions s JOIN runs r ON r.session_id=s.id WHERE s.id=? AND r.id=?').get(sessionId, runId));
  }
}
