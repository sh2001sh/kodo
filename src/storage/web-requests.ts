import type Database from 'better-sqlite3';

export interface WebReceipt { request_id: string; fingerprint: string; response: string; action: string; run_id: string; created_at: string }

/** Idempotency receipts of the HTTP adapter; the table is created on first use, outside the runtime schema version. */
export class WebRequestRecords {
  private ready = false;
  constructor(private readonly db: Database.Database) {}

  ensure(): void {
    if (this.ready) return;
    this.db.exec(`CREATE TABLE IF NOT EXISTS web_requests (
      request_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL,
      action TEXT NOT NULL, run_id TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
    this.ready = true;
  }
  get(requestId: string): WebReceipt | undefined {
    this.ensure();
    return this.db.prepare('SELECT * FROM web_requests WHERE request_id=?').get(requestId) as WebReceipt | undefined;
  }
  insert(receipt: Omit<WebReceipt, 'created_at'>): void {
    this.ensure();
    this.db.prepare('INSERT INTO web_requests VALUES (?,?,?,?,?,?)').run(receipt.request_id, receipt.fingerprint, receipt.response, receipt.action, receipt.run_id, new Date().toISOString());
  }
  /** Receipts for the given actions in creation order; `distinct` collapses repeated (run, action) pairs. */
  byActions(actions: readonly string[], distinct = false): Pick<WebReceipt, 'run_id' | 'action' | 'response'>[] {
    this.ensure();
    if (!actions.length) return [];
    const marks = actions.map(() => '?').join(',');
    const sql = distinct
      ? `SELECT run_id,action,min(response) AS response FROM web_requests WHERE action IN (${marks}) GROUP BY run_id,action ORDER BY min(rowid)`
      : `SELECT run_id,action,response FROM web_requests WHERE action IN (${marks}) ORDER BY created_at,request_id`;
    return this.db.prepare(sql).all(...actions) as Pick<WebReceipt, 'run_id' | 'action' | 'response'>[];
  }
}
