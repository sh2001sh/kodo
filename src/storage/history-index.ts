import type Database from 'better-sqlite3';
import { digest } from './blobs.js';

export interface HistoryPosting { kind: 'history' | 'tool'; source: string; messageIndex: number; callId: string | null; runId: string; recordId: number }
export interface HistoryHit extends HistoryPosting { text: string }

/**
 * Full-text index over retained history texts. Records are deduplicated by digest;
 * postings say where each record occurs (an archive message or a tool result).
 * The trigram tokenizer makes LIKE substring queries of three or more characters
 * use the index; shorter terms (common in Chinese) scan the same table.
 */
export class HistoryIndexRecords {
  private ready = false;
  constructor(private readonly db: Database.Database) {}

  /** Creates the index tables on first use, so stores that never search carry no schema. */
  ensure(): void {
    if (this.ready) return;
    this.db.exec(`CREATE TABLE IF NOT EXISTS history_records(id INTEGER PRIMARY KEY AUTOINCREMENT, digest TEXT UNIQUE NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS history_text USING fts5(text, tokenize='trigram');
      CREATE TABLE IF NOT EXISTS history_sources(source TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS history_postings(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL, message_index INTEGER NOT NULL, call_id TEXT, record_id INTEGER NOT NULL REFERENCES history_records(id), UNIQUE(source,message_index));
      CREATE INDEX IF NOT EXISTS history_postings_run ON history_postings(run_id,seq);`);
    this.ready = true;
  }

  indexed(source: string): boolean {
    this.ensure();
    return Boolean(this.db.prepare('SELECT 1 FROM history_sources WHERE source=?').get(source));
  }

  /** Indexes every text of one immutable source atomically; texts are stored once per digest. */
  add(source: string, entries: { runId: string; kind: 'history' | 'tool'; messageIndex: number; callId?: string; text: string }[]): void {
    this.ensure();
    const find = this.db.prepare('SELECT id FROM history_records WHERE digest=?');
    const record = this.db.prepare('INSERT INTO history_records(digest) VALUES(?)');
    const text = this.db.prepare('INSERT INTO history_text(rowid,text) VALUES(?,?)');
    const posting = this.db.prepare('INSERT OR IGNORE INTO history_postings(run_id,kind,source,message_index,call_id,record_id) VALUES(?,?,?,?,?,?)');
    this.db.transaction(() => {
      if (this.db.prepare('INSERT OR IGNORE INTO history_sources(source) VALUES(?)').run(source).changes === 0) return;
      for (const entry of entries) {
        const key = digest(entry.text);
        let id = (find.get(key) as { id: number } | undefined)?.id;
        if (id === undefined) { id = Number(record.run(key).lastInsertRowid); text.run(id, entry.text); }
        posting.run(entry.runId, entry.kind, source, entry.messageIndex, entry.callId ?? null, id);
      }
    })();
  }

  /** Postings in the given runs whose text contains all terms (ASCII case-insensitive), oldest first. */
  search(runIds: string[], terms: string[]): HistoryHit[] {
    this.ensure();
    if (!runIds.length || !terms.length) return [];
    const like = terms.map(() => "t.text LIKE ? ESCAPE '\\'").join(' AND ');
    return this.db.prepare(`SELECT p.kind, p.source, p.message_index AS messageIndex, p.call_id AS callId, p.run_id AS runId, p.record_id AS recordId, t.text
      FROM history_text t JOIN history_postings p ON p.record_id=t.rowid
      WHERE ${like} AND p.run_id IN (${runIds.map(() => '?').join(',')}) ORDER BY p.seq`).all(...terms.map(term => `%${term.replace(/[\\%_]/g, character => `\\${character}`)}%`), ...runIds) as HistoryHit[];
  }
}
