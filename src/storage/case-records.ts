import type Database from 'better-sqlite3';

export interface CaseRunRow { seq: number; data: string; evidence_digest: string }
export interface CaseRunInsert { id: string; targetId: string; targetVersion: string; caseDigest: string; conditionsDigest: string; status: string; data: string; evidenceDigest: string }
export interface CaseRunFilter { targetId?: string; version?: string; status?: string; after: number; fetch: number }

/** Case evidence tables; the case service owns validation and digests, this owns the SQL. */
export class CaseRecords {
  private ready = false;
  constructor(private readonly db: Database.Database) {}

  /** Creates the case tables on first use, so stores that never run cases carry no schema. */
  ensure(): void {
    if (this.ready) return;
    this.db.exec(`CREATE TABLE IF NOT EXISTS case_definitions(id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS case_runs(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, target_id TEXT NOT NULL, target_version TEXT NOT NULL, case_digest TEXT NOT NULL, conditions_digest TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, evidence_digest TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS case_runs_target ON case_runs(target_id,target_version,seq);
      CREATE INDEX IF NOT EXISTS case_runs_compare ON case_runs(case_digest,conditions_digest,seq);`);
    this.ready = true;
  }
  definitionDigest(id: string, version: string): string | undefined {
    this.ensure();
    return (this.db.prepare('SELECT digest FROM case_definitions WHERE id=? AND version=?').get(id, version) as { digest: string } | undefined)?.digest;
  }
  /** Records a definition digest and a new running case atomically. */
  start(definition: { id: string; version: string; digest: string }, run: CaseRunInsert, guard: (previousDigest: string | undefined) => void): void {
    this.ensure();
    this.db.transaction(() => {
      guard(this.definitionDigest(definition.id, definition.version));
      this.db.prepare('INSERT OR IGNORE INTO case_definitions(id,version,digest) VALUES(?,?,?)').run(definition.id, definition.version, definition.digest);
      this.db.prepare('INSERT INTO case_runs(id,target_id,target_version,case_digest,conditions_digest,status,data,evidence_digest) VALUES(?,?,?,?,?,?,?,?)').run(run.id, run.targetId, run.targetVersion, run.caseDigest, run.conditionsDigest, run.status, run.data, run.evidenceDigest);
    })();
  }
  /** Finalizes a running case; false when it was no longer running. */
  finish(id: string, status: string, data: string, evidenceDigest: string): boolean {
    this.ensure();
    return this.db.prepare("UPDATE case_runs SET status=?,data=?,evidence_digest=? WHERE id=? AND status='running'").run(status, data, evidenceDigest, id).changes === 1;
  }
  /** Compare-and-swap update of a running case's evidence; false when the evidence changed meanwhile. */
  replaceRunning(id: string, data: string, evidenceDigest: string, expectedDigest: string): boolean {
    this.ensure();
    return this.db.prepare("UPDATE case_runs SET data=?,evidence_digest=? WHERE id=? AND status='running' AND evidence_digest=?").run(data, evidenceDigest, id, expectedDigest).changes === 1;
  }
  get(id: string): CaseRunRow | undefined {
    this.ensure();
    return this.db.prepare('SELECT seq,data,evidence_digest FROM case_runs WHERE id=?').get(id) as CaseRunRow | undefined;
  }
  list(filter: CaseRunFilter): CaseRunRow[] {
    this.ensure();
    const clauses = ['seq > ?']; const values: (string | number)[] = [filter.after];
    for (const [column, value] of [['target_id', filter.targetId], ['target_version', filter.version], ['status', filter.status]] as const) if (value !== undefined) { clauses.push(`${column}=?`); values.push(value); }
    return this.db.prepare(`SELECT seq,data,evidence_digest FROM case_runs WHERE ${clauses.join(' AND ')} ORDER BY seq LIMIT ?`).all(...values, filter.fetch) as CaseRunRow[];
  }
}
