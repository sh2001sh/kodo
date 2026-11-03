import type Database from 'better-sqlite3';
import type { Card } from '../runtime/types.js';
import { KodoError } from '../runtime/types.js';

export interface DerivedAgentRecord {
  sessionId: string;
  handle: string;
  base: { id: string; version: string; digest: string };
  digest: string;
  overlay: Record<string, unknown>;
  card: Card;
  createdByRun: string;
}

/** Temporary cards are immutable session assets, deliberately absent from card_versions. */
export class DerivedAgentRecords {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS derived_agents (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      handle TEXT NOT NULL, digest TEXT NOT NULL,
      created_by_run TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      data TEXT NOT NULL, PRIMARY KEY(session_id,handle))`);
  }
  get(sessionId: string, handle: string): DerivedAgentRecord | undefined {
    const row = this.db.prepare('SELECT data FROM derived_agents WHERE session_id=? AND handle=?').get(sessionId, handle) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as DerivedAgentRecord : undefined;
  }
  put(record: DerivedAgentRecord): DerivedAgentRecord {
    const previous = this.get(record.sessionId, record.handle);
    if (previous) {
      if (previous.digest !== record.digest) throw new KodoError('DERIVATION_CONFLICT', 'temporary handle has different immutable content');
      return previous;
    }
    this.db.prepare('INSERT INTO derived_agents(session_id,handle,digest,created_by_run,data) VALUES (?,?,?,?,?)')
      .run(record.sessionId, record.handle, record.digest, record.createdByRun, JSON.stringify(record));
    return record;
  }
}
