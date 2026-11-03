import type Database from 'better-sqlite3';
import { KodoError } from '../runtime/types.js';

export type CheckpointState = { kind: 'absent' } | { kind: 'directory' } | { kind: 'file'; hash: string; bytes: number; contentRef?: string; mode?: number };
export interface Checkpoint { id: string; runId: string; step: number; preparationId: string; paths: Record<string, string>; before: Record<string, CheckpointState>; after?: Record<string, CheckpointState> }
export const checkpointSchema = `CREATE TABLE IF NOT EXISTS file_checkpoints(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,run_id TEXT NOT NULL REFERENCES runs(id),step INTEGER NOT NULL,preparation_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS file_checkpoints_run ON file_checkpoints(run_id,seq DESC);
  CREATE TABLE IF NOT EXISTS file_checkpoint_floors(run_id TEXT PRIMARY KEY REFERENCES runs(id),step INTEGER NOT NULL);`;

/** Native file checkpoints retain at most the latest hundred mutations per run. */
export class CheckpointRecords {
  constructor(private readonly db: Database.Database) {}
  put(record: Checkpoint): void {
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO file_checkpoints(id,run_id,step,preparation_id,data) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(record.id, record.runId, record.step, record.preparationId, JSON.stringify(record));
      this.db.prepare('INSERT INTO file_checkpoint_floors(run_id,step) SELECT run_id,max(step) FROM file_checkpoints WHERE run_id=? AND seq NOT IN (SELECT seq FROM file_checkpoints WHERE run_id=? ORDER BY seq DESC LIMIT 100) GROUP BY run_id ON CONFLICT(run_id) DO UPDATE SET step=max(step,excluded.step)').run(record.runId, record.runId);
      this.db.prepare('DELETE FROM file_checkpoints WHERE run_id=? AND seq NOT IN (SELECT seq FROM file_checkpoints WHERE run_id=? ORDER BY seq DESC LIMIT 100)').run(record.runId, record.runId);
    })();
  }
  list(runId: string): Checkpoint[] { return (this.db.prepare('SELECT data FROM file_checkpoints WHERE run_id=? ORDER BY seq DESC LIMIT 100').all(runId) as { data: string }[]).map(row => JSON.parse(row.data) as Checkpoint); }
  floor(runId: string): number | undefined { return (this.db.prepare('SELECT step FROM file_checkpoint_floors WHERE run_id=?').get(runId) as { step: number } | undefined)?.step; }
  complete(preparationId: string, after: Record<string, CheckpointState>): void {
    const row = this.db.prepare('SELECT data FROM file_checkpoints WHERE preparation_id=?').get(preparationId) as { data: string } | undefined;
    if (!row) throw new KodoError('CHECKPOINT_NOT_FOUND', 'file checkpoint preparation is not retained');
    this.db.prepare('UPDATE file_checkpoints SET data=? WHERE preparation_id=?').run(JSON.stringify({ ...JSON.parse(row.data) as Checkpoint, after }), preparationId);
  }
  deleteAfter(runId: string, step: number): void { this.db.prepare('DELETE FROM file_checkpoints WHERE run_id=? AND step>?').run(runId, step); }
}
