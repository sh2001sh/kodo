import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, realpathSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Call, Card, Envelope, Run, RuntimeEvent, Session, Wait } from '../runtime/types.js';
import { defaultBudget, KodoError } from '../runtime/types.js';

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export class Store {
  readonly db: Database.Database;
  readonly directory: string;
  private lockPath: string;
  private lockToken = randomUUID();
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private pendingEvents: RuntimeEvent[] | undefined;
  private closed = false;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.directory = realpathSync(directory);
    this.lockPath = path.join(this.directory, 'owner.lock');
    let fd: number;
    try { fd = openSync(this.lockPath, 'wx', 0o600); }
    catch { throw new KodoError('DATA_LOCKED', 'data directory is owned or has a stale lock; use kodo doctor --unlock only after the owner has exited'); }
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token: this.lockToken }), 'utf8');
    } finally { closeSync(fd); }
    let opened: Database.Database | undefined;
    try {
      mkdirSync(path.join(this.directory, 'blobs'), { recursive: true });
      this.db = opened = new Database(path.join(this.directory, 'kodo.sqlite'));
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 5000');
      const version = this.db.pragma('user_version', { simple: true }) as number;
      if (version > 3) throw new KodoError('DB_VERSION', 'database requires a newer Kodo version');
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), status TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS calls_run ON calls(run_id);
        CREATE TABLE IF NOT EXISTS card_versions(id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id,version));
        CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), ref TEXT NOT NULL${version === 0 ? ', decision_version INTEGER NOT NULL DEFAULT 0' : ''});
        ${version > 0 && version < 3 ? 'ALTER TABLE artifacts ADD COLUMN decision_version INTEGER NOT NULL DEFAULT 0;' : ''}
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, run_id TEXT NOT NULL, type TEXT NOT NULL, time TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id), recipient TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS messages_recipient ON messages(recipient,seq);
        CREATE TABLE IF NOT EXISTS waits(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS decisions(session_id TEXT NOT NULL REFERENCES sessions(id), version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,version));
        CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id,status);
        CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
        CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id,seq);
        CREATE INDEX IF NOT EXISTS messages_reply ON messages(json_extract(data,'$.replyTo'),json_extract(data,'$.kind'));
        CREATE INDEX IF NOT EXISTS events_run ON events(run_id,seq);
        CREATE INDEX IF NOT EXISTS events_call ON events(run_id,type,json_extract(data,'$.callId'),seq);
        CREATE INDEX IF NOT EXISTS calls_effect_status ON calls(json_extract(data,'$.kind'),json_extract(data,'$.effect'),json_extract(data,'$.status'));
        CREATE INDEX IF NOT EXISTS waits_status ON waits(json_extract(data,'$.status'),run_id);
        PRAGMA user_version = 3;
        COMMIT;
      `);
      for (const file of readdirSync(path.join(this.directory, 'blobs'))) if (/^[a-f0-9]{64}\.[0-9a-f-]{36}\.tmp$/.test(file)) unlinkSync(path.join(this.directory, 'blobs', file));
      this.transaction(() => {
        const sessions = (this.db.prepare('SELECT data FROM sessions').all() as { data: string }[]).map(row => JSON.parse(row.data) as Session);
        for (const session of sessions) if (session.activeSince !== undefined) {
          // Death time cannot be established after a crash. Charge the entire uncertain interval,
          // capped at the budget, so restarting cannot reset execution time.
          this.putSession({ ...session, activeMs: Math.min(session.budget.maxDurationMs ?? Infinity, (session.activeMs ?? 0) + Math.max(0, Date.now() - session.activeSince)), activeSince: undefined });
        }
        for (const run of this.listRuns(undefined, 'running')) {
          if (run.status === 'running') {
            this.updateRun(run.id, { status: 'interrupted' });
            this.event(run.id, 'run.interrupted', { reason: 'previous process exited before finishing' });
          }
        }
      });
    } catch (error) {
      try { opened?.close(); } finally { this.releaseLock(); }
      throw error;
    }
  }

  transaction<T>(action: () => T): T {
    if (this.pendingEvents) return action();
    this.pendingEvents = [];
    let result: T;
    let committed: RuntimeEvent[];
    try {
      result = this.db.transaction(action)();
      committed = this.pendingEvents;
    } finally { this.pendingEvents = undefined; }
    for (const event of committed) for (const listener of this.listeners) listener(event);
    return result;
  }
  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  blob(value: unknown): string {
    const content = JSON.stringify(value);
    const ref = digest(content);
    const target = path.join(this.directory, 'blobs', `${ref}.json`);
    if (existsSync(target)) return ref;
    const temp = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, target);
    return ref;
  }
  readBlob<T>(ref: string): T {
    if (!/^[a-f0-9]{64}$/.test(ref)) throw new KodoError('BLOB_REF', 'invalid content reference');
    const content = readFileSync(path.join(this.directory, 'blobs', `${ref}.json`), 'utf8');
    if (digest(content) !== ref) throw new KodoError('BLOB_CORRUPT', 'stored content digest mismatch');
    return JSON.parse(content) as T;
  }
  putSession(session: Session): void {
    this.db.prepare('INSERT INTO sessions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(session.id, JSON.stringify(session));
  }
  session(id: string): Session {
    const session = this.row<Session>('sessions', id);
    // Old sessions retain the limits persisted at creation; missing windows used the old 256k default.
    return { ...session, budget: { ...defaultBudget, ...session.budget, maxContextTokens: session.budget.maxContextTokens ?? 256_000 } };
  }
  putRun(run: Run): void {
    this.db.prepare('INSERT INTO runs VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data')
      .run(run.id, run.sessionId, run.status, JSON.stringify(run));
  }
  run(id: string): Run { return this.row<Run>('runs', id); }
  updateRun(id: string, patch: Partial<Run>): Run {
    const updated = { ...this.run(id), ...patch };
    this.putRun(updated);
    return updated;
  }
  listRuns(sessionId?: string, status?: Run['status']): Run[] {
    const where = [sessionId ? 'session_id=@sessionId' : '', status ? 'status=@status' : ''].filter(Boolean);
    return (this.db.prepare(`SELECT data FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid`).all({ sessionId: sessionId ?? null, status: status ?? null }) as { data: string }[]).map(x => JSON.parse(x.data) as Run);
  }
  putCall(call: Call): void {
    this.db.prepare('INSERT INTO calls VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(call.id, call.runId, JSON.stringify(call));
  }
  call(id: string): Call { return this.row<Call>('calls', id); }
  calls(runId: string): Call[] {
    return (this.db.prepare('SELECT data FROM calls WHERE run_id=? ORDER BY rowid').all(runId) as { data: string }[]).map(x => JSON.parse(x.data) as Call);
  }
  /** Unresolved effects block writes to overlapping canonical workspaces across sessions. */
  unresolvedWrites(workspace?: string, sessionId?: string): Call[] {
    const overlaps = (left: string, right: string): boolean => {
      const inside = (root: string, target: string): boolean => {
        const relative = path.relative(root, target);
        return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      };
      return inside(left, right) || inside(right, left);
    };
    const rows = this.db.prepare(`SELECT c.data,r.status,s.data AS session FROM calls c JOIN runs r ON r.id=c.run_id JOIN sessions s ON s.id=r.session_id
      WHERE json_extract(c.data,'$.kind')='tool' AND json_extract(c.data,'$.effect')='write'
      AND json_extract(c.data,'$.status') IN ('unknown','running') ${sessionId ? 'AND r.session_id=@sessionId' : ''}`)
      .all({ sessionId: sessionId ?? null }) as { data: string; status: Run['status']; session: string }[];
    return rows.filter(row => !workspace || overlaps(workspace, (JSON.parse(row.session) as Session).workspace)).map(row => ({ row, call: JSON.parse(row.data) as Call })).filter(({ row, call }) => {
      if (call.status !== 'unknown' && (call.effectState === 'not_started' || call.effectAtomic || !['interrupted', 'failed', 'cancelled', 'completed'].includes(row.status))) return false;
      return !this.db.prepare(`SELECT 1 FROM events WHERE run_id=? AND type='recovery.resolved' AND json_extract(data,'$.callId')=?
        AND seq>COALESCE((SELECT MAX(seq) FROM events WHERE run_id=? AND type='tool.started' AND json_extract(data,'$.callId')=?),0) LIMIT 1`).get(call.runId, call.id, call.runId, call.id);
    }).map(({ call }) => call);
  }
  registerCard(card: Card): void {
    const existing = this.db.prepare('SELECT digest FROM card_versions WHERE id=? AND version=?').get(card.id, card.version) as { digest: string } | undefined;
    if (existing && existing.digest !== card.digest) throw new KodoError('CARD_CONFLICT', 'same card ID and version has different content');
    if (!existing) this.db.prepare('INSERT INTO card_versions VALUES (?,?,?,?)').run(card.id, card.version, card.digest, JSON.stringify(card));
  }
  card(id: string, version: string): Card {
    const row = this.db.prepare('SELECT data FROM card_versions WHERE id=? AND version=?').get(id, version) as { data: string } | undefined;
    if (!row) throw new KodoError('CARD_NOT_FOUND', 'card version is not registered');
    return JSON.parse(row.data) as Card;
  }
  artifact(runId: string, ref: string): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO artifacts(id,run_id,ref,decision_version) VALUES (?,?,?,?)').run(id, runId, ref, this.run(runId).decisionVersion ?? 0);
    return id;
  }
  readArtifact(runId: string, id: string): unknown {
    const run = this.run(runId);
    const row = this.db.prepare('SELECT a.ref,a.run_id,a.decision_version FROM artifacts a JOIN runs r ON r.id=a.run_id WHERE a.id=? AND r.session_id=?').get(id, run.sessionId) as { ref: string; run_id: string; decision_version: number } | undefined;
    if (!row) throw new KodoError('ARTIFACT_DENIED', 'artifact does not belong to this session');
    const value = this.readBlob<unknown>(row.ref);
    return { ...(typeof value === 'object' && value !== null && !Array.isArray(value) ? value : { value }), provenance: { runId: row.run_id, decisionVersion: row.decision_version, stale: row.decision_version < (this.session(run.sessionId).decisionVersion ?? 0) } };
  }
  message(id: string): Envelope | undefined {
    const row = this.db.prepare('SELECT seq,data FROM messages WHERE id=?').get(id) as { seq: number; data: string } | undefined;
    return row ? { ...JSON.parse(row.data) as Envelope, seq: row.seq } : undefined;
  }
  putMessage(message: Omit<Envelope, 'seq'>): Envelope {
    const previous = this.message(message.id);
    if (previous) {
      if (JSON.stringify({ ...previous, seq: undefined }) !== JSON.stringify(message)) throw new KodoError('MESSAGE_CONFLICT', 'message ID was reused with different content');
      return previous;
    }
    const row = this.db.prepare('INSERT INTO messages(id,session_id,recipient,data) VALUES (?,?,?,?)').run(message.id, message.sessionId, message.to, JSON.stringify(message));
    const result = { ...message, seq: Number(row.lastInsertRowid) };
    this.event(message.to === 'user' ? message.from : message.to, 'message.created', { messageId: result.id, messageSeq: result.seq });
    return result;
  }
  messages(sessionId: string): Envelope[] {
    return (this.db.prepare('SELECT seq,data FROM messages WHERE session_id=? ORDER BY seq').all(sessionId) as { seq: number; data: string }[])
      .map(row => ({ ...JSON.parse(row.data) as Envelope, seq: row.seq }));
  }
  inbox(runId: string): Envelope[] {
    const run = this.run(runId);
    return (this.db.prepare('SELECT seq,data FROM messages WHERE recipient=? AND seq>? ORDER BY seq').all(runId, run.inputCursor ?? 0) as { seq: number; data: string }[]).map(row => ({ ...JSON.parse(row.data) as Envelope, seq: row.seq }));
  }
  answer(questionId: string): Envelope | undefined {
    const row = this.db.prepare("SELECT seq,data FROM messages WHERE json_extract(data,'$.replyTo')=? AND json_extract(data,'$.kind')='answer' ORDER BY seq LIMIT 1").get(questionId) as { seq: number; data: string } | undefined;
    return row ? { ...JSON.parse(row.data) as Envelope, seq: row.seq } : undefined;
  }
  unansweredQuestions(sessionId: string, recipient?: string): Envelope[] {
    const rows = this.db.prepare(`SELECT m.seq,m.data FROM messages m WHERE m.session_id=@sessionId ${recipient ? 'AND m.recipient=@recipient' : ''}
      AND json_extract(m.data,'$.kind')='question' AND NOT EXISTS (SELECT 1 FROM messages a WHERE json_extract(a.data,'$.replyTo')=m.id AND json_extract(a.data,'$.kind')='answer') ORDER BY m.seq`)
      .all({ sessionId, recipient: recipient ?? null }) as { seq: number; data: string }[];
    return rows.map(row => ({ ...JSON.parse(row.data) as Envelope, seq: row.seq }));
  }
  putWait(wait: Wait): void {
    this.db.prepare('INSERT INTO waits VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(wait.id, wait.runId, JSON.stringify(wait));
  }
  wait(id: string): Wait {
    const row = this.db.prepare('SELECT data FROM waits WHERE id=?').get(id) as { data: string } | undefined;
    if (!row) throw new KodoError('WAIT_NOT_FOUND', 'wait record not found');
    return JSON.parse(row.data) as Wait;
  }
  waits(sessionId?: string, registeredOnly = false): Wait[] {
    return (this.db.prepare(`SELECT w.data FROM waits w JOIN runs r ON r.id=w.run_id WHERE (@sessionId IS NULL OR r.session_id=@sessionId) ${registeredOnly ? "AND json_extract(w.data,'$.status')='registered'" : ''}`).all({ sessionId: sessionId ?? null }) as { data: string }[]).map(x => JSON.parse(x.data) as Wait);
  }
  /** Exclusive directory ownership makes mark/sweep safe between runtime operations. */
  gc(options: { vacuum?: boolean; olderThanDays?: number } = {}): { removedBlobs: number; freedBytes: number; removedSessions: number } {
    if (this.db.inTransaction || this.listRuns(undefined, 'running').length) throw new KodoError('GC_ACTIVE', 'stop active execution before garbage collection');
    if (options.olderThanDays !== undefined && (!Number.isSafeInteger(options.olderThanDays) || options.olderThanDays < 1)) throw new KodoError('GC_RETENTION', 'olderThanDays must be a positive integer');
    let removedSessions = 0;
    if (options.olderThanDays !== undefined) this.transaction(() => {
      const cutoff = Date.now() - options.olderThanDays! * 86_400_000;
      const sessions = this.db.prepare('SELECT data FROM sessions').all() as { data: string }[];
      for (const row of sessions) {
        const session = JSON.parse(row.data) as Session;
        const runs = this.listRuns(session.id);
        if (session.activeSince !== undefined || Date.parse(session.createdAt) >= cutoff || runs.some(run => !['completed', 'failed', 'cancelled'].includes(run.status)) || this.unresolvedWrites(undefined, session.id).length) continue;
        // Retention is measured from the last activity, not merely session creation.
        const latest = this.db.prepare('SELECT MAX(time) AS time FROM events WHERE session_id=?').get(session.id) as { time: string | null };
        if (latest.time && Date.parse(latest.time) >= cutoff) continue;
        for (const run of runs) {
          for (const table of ['calls', 'artifacts', 'waits', 'events']) this.db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(run.id);
        }
        for (const table of ['messages', 'decisions', 'runs']) this.db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(session.id);
        this.db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
        removedSessions++;
      }
    });
    const marked = new Set<string>();
    const queue: string[] = [];
    const mark = (content: string): void => {
      for (const ref of content.match(/[a-f0-9]{64}/g) ?? []) if (!marked.has(ref)) { marked.add(ref); queue.push(ref); }
    };
    for (const table of ['sessions', 'runs', 'calls', 'card_versions', 'artifacts', 'events', 'messages', 'waits', 'decisions']) {
      for (const row of this.db.prepare(`SELECT * FROM ${table}`).iterate()) mark(JSON.stringify(row));
    }
    // References can be nested inside archived snapshots or JSON message strings.
    for (let index = 0; index < queue.length; index++) {
      const ref = queue[index]!;
      if (existsSync(path.join(this.directory, 'blobs', `${ref}.json`))) mark(JSON.stringify(this.readBlob(ref)));
    }
    let removedBlobs = 0;
    let freedBytes = 0;
    for (const file of readdirSync(path.join(this.directory, 'blobs'))) if (/^[a-f0-9]{64}\.json$/.test(file) && !marked.has(file.slice(0, 64))) {
      const target = path.join(this.directory, 'blobs', file);
      freedBytes += statSync(target).size;
      unlinkSync(target);
      removedBlobs++;
    }
    if (options.vacuum) { this.db.pragma('wal_checkpoint(TRUNCATE)'); this.db.exec('VACUUM'); }
    return { removedBlobs, freedBytes, removedSessions };
  }
  putDecision(sessionId: string, version: number, content: string): void {
    this.db.prepare('INSERT INTO decisions VALUES (?,?,?)').run(sessionId, version, JSON.stringify({ content }));
  }
  decisions(sessionId: string): { version: number; content: string }[] {
    return (this.db.prepare('SELECT version,data FROM decisions WHERE session_id=? ORDER BY version').all(sessionId) as { version: number; data: string }[])
      .map(x => ({ version: x.version, ...JSON.parse(x.data) as { content: string } }));
  }
  event(runId: string, type: string, data: Record<string, unknown> = {}): void {
    if (!this.pendingEvents) return this.transaction(() => this.event(runId, type, data));
    const run = this.run(runId);
    const time = new Date().toISOString();
    const row = this.db.prepare('INSERT INTO events(session_id,run_id,type,time,data) VALUES (?,?,?,?,?)').run(run.sessionId, runId, type, time, JSON.stringify(data));
    this.pendingEvents.push({ seq: Number(row.lastInsertRowid), sessionId: run.sessionId, runId, type, time, version: 1, data });
  }
  events(runId: string, after = 0): RuntimeEvent[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq').all(runId, after) as {
      seq: number; session_id: string; run_id: string; type: string; time: string; data: string;
    }[];
    return rows.map(x => ({ seq: x.seq, sessionId: x.session_id, runId: x.run_id, type: x.type, time: x.time, version: 1, data: JSON.parse(x.data) as Record<string, unknown> }));
  }
  probeSearch(): boolean {
    this.db.exec("CREATE VIRTUAL TABLE temp.search_probe USING fts5(text, tokenize='trigram'); INSERT INTO temp.search_probe VALUES ('数据库分析员');");
    try { return Boolean(this.db.prepare("SELECT rowid FROM temp.search_probe WHERE text MATCH ?").get('数据库')); }
    finally { this.db.exec('DROP TABLE temp.search_probe'); }
  }
  close(): void {
    if (this.closed) return;
    this.db.close();
    this.releaseLock();
    this.closed = true;
  }
  private row<T>(table: 'sessions' | 'runs' | 'calls', id: string): T {
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as { data: string } | undefined;
    if (!row) throw new KodoError('NOT_FOUND', `${table} record not found`);
    return JSON.parse(row.data) as T;
  }
  private releaseLock(): void {
    const owner = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { token: string };
    if (owner.token !== this.lockToken) throw new KodoError('LOCK_OWNER', 'data directory ownership changed');
    unlinkSync(this.lockPath);
  }
}

export function unlockData(directory: string): void {
  const lock = path.join(directory, 'owner.lock');
  const owner = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number };
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new KodoError('LOCK_INVALID', 'cannot verify lock owner');
  try { process.kill(owner.pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') { unlinkSync(lock); return; }
    throw new KodoError('LOCK_UNVERIFIED', 'cannot prove the owning process has exited');
  }
  throw new KodoError('DATA_LOCKED', 'owning process is still alive');
}
