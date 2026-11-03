import type Database from 'better-sqlite3';

/** Content of one file as a run last saw it through a native read or its own native write. */
export interface FileState { path: string; hash: string; size: number; mtimeMs: number; notifiedHash: string | null }

export const fileStateSchema = 'CREATE TABLE IF NOT EXISTS file_states(run_id TEXT NOT NULL REFERENCES runs(id), path TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, notified_hash TEXT, updated INTEGER NOT NULL, PRIMARY KEY(run_id,path)) WITHOUT ROWID;';

type Row = { path: string; hash: string; size: number; mtime_ms: number; notified_hash: string | null };
const state = (row: Row): FileState => ({ path: row.path, hash: row.hash, size: row.size, mtimeMs: row.mtime_ms, notifiedHash: row.notified_hash });

/** Per-run read state backing the stale-write guard and the changed-files notice. */
export class FileStateRecords {
  private readonly statements: {
    get: Database.Statement; put: Database.Statement; remove: Database.Statement; recent: Database.Statement; notified: Database.Statement; refresh: Database.Statement;
  };
  constructor(db: Database.Database) {
    this.statements = {
      get: db.prepare('SELECT path,hash,size,mtime_ms,notified_hash FROM file_states WHERE run_id=? AND path=?'),
      put: db.prepare('INSERT INTO file_states(run_id,path,hash,size,mtime_ms,notified_hash,updated) VALUES (?,?,?,?,?,NULL,?) ON CONFLICT(run_id,path) DO UPDATE SET hash=excluded.hash,size=excluded.size,mtime_ms=excluded.mtime_ms,notified_hash=NULL,updated=excluded.updated'),
      remove: db.prepare('DELETE FROM file_states WHERE run_id=? AND path=?'),
      recent: db.prepare('SELECT path,hash,size,mtime_ms,notified_hash FROM file_states WHERE run_id=? ORDER BY updated DESC, path LIMIT ?'),
      notified: db.prepare('UPDATE file_states SET notified_hash=?,size=?,mtime_ms=? WHERE run_id=? AND path=?'),
      refresh: db.prepare('UPDATE file_states SET size=?,mtime_ms=? WHERE run_id=? AND path=? AND hash=?'),
    };
  }
  get(runId: string, file: string): FileState | undefined {
    const row = this.statements.get.get(runId, file) as Row | undefined;
    return row && state(row);
  }
  /** Records content the run has now seen; clears any earlier change notice for the file. */
  put(runId: string, file: string, observed: { hash: string; size: number; mtimeMs: number }): void {
    this.statements.put.run(runId, file, observed.hash, observed.size, observed.mtimeMs, Date.now());
  }
  remove(runId: string, file: string): void { this.statements.remove.run(runId, file); }
  /** Most recently observed files first. */
  recent(runId: string, limit: number): FileState[] { return (this.statements.recent.all(runId, limit) as Row[]).map(state); }
  /** Marks a changed hash as reported without treating its content as seen. */
  markNotified(runId: string, file: string, observed: { hash: string; size: number; mtimeMs: number }): void {
    this.statements.notified.run(observed.hash, observed.size, observed.mtimeMs, runId, file);
  }
  /** Updates file metadata after a touch that left the seen content unchanged. */
  refreshStat(runId: string, file: string, hash: string, observed: { size: number; mtimeMs: number }): void {
    this.statements.refresh.run(observed.size, observed.mtimeMs, runId, file, hash);
  }
}
