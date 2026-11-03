import type Database from 'better-sqlite3';

export interface AgentDraftRow { id: string; sessionId: string; sourceRun: string; ownerId: string; digest: string; status: string; data: string }
export const agentDraftSchema = `
  CREATE TABLE IF NOT EXISTS agent_drafts(draft_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,source_run TEXT NOT NULL,owner_id TEXT NOT NULL,digest TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(session_id,source_run));
  CREATE INDEX IF NOT EXISTS agent_drafts_session ON agent_drafts(session_id,draft_id);
  CREATE TABLE IF NOT EXISTS agent_retention_preferences(owner_id TEXT PRIMARY KEY,consecutive_skips INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS agent_retention_actions(user_event_id TEXT PRIMARY KEY,draft_id TEXT NOT NULL,digest TEXT NOT NULL,decision TEXT NOT NULL);
`;
const columns = 'draft_id AS id,session_id AS sessionId,source_run AS sourceRun,owner_id AS ownerId,digest,status,data';

/** Durable proposal state. A draft never enters card_versions until the host approves its digest. */
export class AgentDraftRecords {
  constructor(private readonly db: Database.Database) {}
  get(id: string): AgentDraftRow | undefined { return this.db.prepare(`SELECT ${columns} FROM agent_drafts WHERE draft_id=?`).get(id) as AgentDraftRow | undefined; }
  forSource(sessionId: string, sourceRun: string): AgentDraftRow | undefined { return this.db.prepare(`SELECT ${columns} FROM agent_drafts WHERE session_id=? AND source_run=?`).get(sessionId, sourceRun) as AgentDraftRow | undefined; }
  put(row: AgentDraftRow): void {
    this.db.prepare('INSERT INTO agent_drafts(draft_id,session_id,source_run,owner_id,digest,status,data) VALUES (?,?,?,?,?,?,?) ON CONFLICT(draft_id) DO UPDATE SET digest=excluded.digest,status=excluded.status,data=excluded.data').run(row.id, row.sessionId, row.sourceRun, row.ownerId, row.digest, row.status, row.data);
  }
  list(ownerId: string, sessionId?: string): AgentDraftRow[] {
    return this.db.prepare(`SELECT ${columns} FROM agent_drafts WHERE owner_id=? ${sessionId === undefined ? '' : 'AND session_id=?'} ORDER BY rowid DESC`).all(ownerId, ...(sessionId === undefined ? [] : [sessionId])) as AgentDraftRow[];
  }
  /** Sessions keep source evidence while their drafts remain reviewable. */
  sessionIds(): string[] { return (this.db.prepare('SELECT DISTINCT session_id FROM agent_drafts').all() as { session_id: string }[]).map(row => row.session_id); }
  skipCount(ownerId: string): number { return (this.db.prepare('SELECT consecutive_skips FROM agent_retention_preferences WHERE owner_id=?').get(ownerId) as { consecutive_skips: number } | undefined)?.consecutive_skips ?? 0; }
  skipped(ownerId: string): void { this.db.prepare('INSERT INTO agent_retention_preferences(owner_id,consecutive_skips) VALUES (?,1) ON CONFLICT(owner_id) DO UPDATE SET consecutive_skips=min(2,consecutive_skips+1)').run(ownerId); }
  resetSkips(ownerId: string): void { this.db.prepare('INSERT INTO agent_retention_preferences(owner_id,consecutive_skips) VALUES (?,0) ON CONFLICT(owner_id) DO UPDATE SET consecutive_skips=0').run(ownerId); }
  action(userEventId: string): { draftId: string; digest: string; decision: string } | undefined {
    return this.db.prepare('SELECT draft_id AS draftId,digest,decision FROM agent_retention_actions WHERE user_event_id=?').get(userEventId) as { draftId: string; digest: string; decision: string } | undefined;
  }
  recordAction(userEventId: string, draftId: string, digest: string, decision: string): void {
    this.db.prepare('INSERT INTO agent_retention_actions(user_event_id,draft_id,digest,decision) VALUES (?,?,?,?)').run(userEventId, draftId, digest, decision);
  }
  declined(draftId: string, digest: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM agent_retention_actions WHERE draft_id=? AND digest=? AND decision IN ('reject','skip') LIMIT 1").get(draftId, digest)); }
}
