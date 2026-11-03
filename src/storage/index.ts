import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, realpathSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Call, Card, Envelope, Run, RuntimeEvent, Session, Wait } from '../runtime/types.js';
import { defaultBudget, KodoError } from '../runtime/types.js';
import { BlobStore } from './blobs.js';
import { CaseRecords } from './case-records.js';
import { KnowledgeRecords } from './knowledge.js';
import { WebRequestRecords } from './web-requests.js';
import { FileStateRecords, fileStateSchema } from './file-states.js';
import { CheckpointRecords, checkpointSchema } from './checkpoints.js';
import { bindStorageTestConnection } from './test-access.js';
import { guardedConnection, storageFault } from './fault.js';
import { counterBackfill, counterSchema, countCalls, countEvents, eventFromRow, latestEventSeq, queryCalls, selectEvents } from './events.js';
import type { CallCountFilter, CallQueryFilter, EventFilter, StoredEvent } from './events.js';

export { BlobStore, digest } from './blobs.js';
export type { CallCountFilter, CallQueryFilter, EventFilter, EventMatch } from './events.js';
export type { WebReceipt } from './web-requests.js';
export interface PageOptions { after?: number; limit?: number }
export interface Page<T> { items: T[]; next: number | null }
export interface SubscriberError { event: RuntimeEvent; error: unknown }
export interface StoreOptions { onSubscriberError?: (failure: SubscriberError) => void }
function pageBounds(options: PageOptions): { after: number; limit: number } {
  const { after = 0, limit = 100 } = options;
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new KodoError('PAGE_BOUNDS', 'after must be a nonnegative safe integer and limit must be an integer from 1 to 1000');
  return { after, limit };
}
function pageOf<T>(rows: { seq: number; item: T }[], limit: number): Page<T> {
  const visible = rows.slice(0, limit);
  return { items: visible.map(row => row.item), next: rows.length > limit ? visible.at(-1)!.seq : null };
}
export class Store {
  readonly #db: Database.Database;
  readonly directory: string;
  private lockPath: string;
  private lockToken = randomUUID();
  private listeners = new Set<(event: RuntimeEvent) => void>();
  private pendingEvents: RuntimeEvent[] | undefined;
  private closed = false;
  private storageFailure: unknown;
  private readonly faultListeners = new Set<(error: unknown) => void>();
  private readonly blobs: BlobStore;
  /** Named knowledge-table queries for the knowledge service. */
  readonly knowledge: KnowledgeRecords;
  /** Case evidence tables, created on first use. */
  readonly cases: CaseRecords;
  /** HTTP adapter idempotency receipts, created on first use. */
  readonly webRequests: WebRequestRecords;
  /** Per-run file read state for the stale-write guard. */
  readonly fileStates: FileStateRecords;
  readonly checkpoints: CheckpointRecords;

  constructor(directory: string, private readonly options: StoreOptions = {}) {
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
      opened = new Database(path.join(this.directory, 'kodo.sqlite'));
      this.#db = guardedConnection(opened, () => this.assertWritable(), error => this.fail(error));
      bindStorageTestConnection(this, opened);
      this.#db.pragma('journal_mode = WAL');
      this.#db.pragma('synchronous = FULL');
      this.#db.pragma('foreign_keys = ON');
      this.#db.pragma('busy_timeout = 5000');
      const version = this.#db.pragma('user_version', { simple: true }) as number;
      const counted = Boolean(this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='event_counts'").get());
      if (version > 7) throw new KodoError('DB_VERSION', 'database requires a newer Kodo version');
      this.#db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), status TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS calls_run ON calls(run_id);
        CREATE INDEX IF NOT EXISTS calls_model_status ON calls(run_id,json_extract(data,'$.kind'),json_extract(data,'$.status'));
        CREATE TABLE IF NOT EXISTS card_versions(id TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id,version));
        CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), ref TEXT NOT NULL${version === 0 ? ', decision_version INTEGER NOT NULL DEFAULT 0' : ''});
        ${version > 0 && version < 3 ? 'ALTER TABLE artifacts ADD COLUMN decision_version INTEGER NOT NULL DEFAULT 0;' : ''}
        CREATE TABLE IF NOT EXISTS blob_segments(ref TEXT PRIMARY KEY, data TEXT NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, run_id TEXT NOT NULL, type TEXT NOT NULL, time TEXT NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id), recipient TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS messages_recipient ON messages(recipient,seq);
        CREATE TABLE IF NOT EXISTS waits(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS decisions(session_id TEXT NOT NULL REFERENCES sessions(id), version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id,version));
        CREATE TABLE IF NOT EXISTS knowledge_projects(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, workspace TEXT NOT NULL, UNIQUE(owner_id,workspace));
        CREATE TABLE IF NOT EXISTS knowledge_versions(seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES knowledge_projects(id), id TEXT NOT NULL, revision INTEGER NOT NULL, source_run_id TEXT NOT NULL, body_ref TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(project_id,id,revision), UNIQUE(project_id,source_run_id));
        CREATE INDEX IF NOT EXISTS knowledge_project_order ON knowledge_versions(project_id,seq);
        CREATE TABLE IF NOT EXISTS knowledge_uses(seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL, run_id TEXT NOT NULL, purpose TEXT NOT NULL, time TEXT NOT NULL, UNIQUE(project_id,id,revision,run_id,purpose), FOREIGN KEY(project_id,id,revision) REFERENCES knowledge_versions(project_id,id,revision));
        CREATE TABLE IF NOT EXISTS knowledge_nodes(project_id TEXT NOT NULL REFERENCES knowledge_projects(id), id TEXT NOT NULL, parent_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('folder','entry')), title TEXT NOT NULL, knowledge_id TEXT, PRIMARY KEY(project_id,id), UNIQUE(project_id,knowledge_id), FOREIGN KEY(project_id,parent_id) REFERENCES knowledge_nodes(project_id,id), CHECK((kind='entry' AND knowledge_id IS NOT NULL) OR (kind='folder' AND knowledge_id IS NULL)));
        CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id,status);
        CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
        CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id,seq);
        CREATE INDEX IF NOT EXISTS messages_reply ON messages(json_extract(data,'$.replyTo'),json_extract(data,'$.kind'));
        CREATE INDEX IF NOT EXISTS events_run ON events(run_id,seq);
        CREATE INDEX IF NOT EXISTS events_session ON events(session_id,seq);
        CREATE INDEX IF NOT EXISTS events_call ON events(run_id,type,json_extract(data,'$.callId'),seq);
        CREATE INDEX IF NOT EXISTS calls_effect_status ON calls(json_extract(data,'$.kind'),json_extract(data,'$.effect'),json_extract(data,'$.status'));
        CREATE INDEX IF NOT EXISTS waits_status ON waits(json_extract(data,'$.status'),run_id);
        CREATE TABLE IF NOT EXISTS record_order(seq INTEGER PRIMARY KEY AUTOINCREMENT, entity TEXT NOT NULL, id TEXT NOT NULL, UNIQUE(entity,id));
        CREATE INDEX IF NOT EXISTS record_order_entity ON record_order(entity,seq);
        INSERT INTO record_order(entity,id) SELECT 'sessions',s.id FROM sessions s WHERE NOT EXISTS (SELECT 1 FROM record_order o WHERE o.entity='sessions' AND o.id=s.id) ORDER BY s.rowid;
        INSERT INTO record_order(entity,id) SELECT 'runs',r.id FROM runs r WHERE NOT EXISTS (SELECT 1 FROM record_order o WHERE o.entity='runs' AND o.id=r.id) ORDER BY r.rowid;
        INSERT INTO record_order(entity,id) SELECT 'calls',c.id FROM calls c WHERE NOT EXISTS (SELECT 1 FROM record_order o WHERE o.entity='calls' AND o.id=c.id) ORDER BY c.rowid;
        ${(['sessions', 'runs', 'calls'] as const).map(table => `
          CREATE TRIGGER IF NOT EXISTS ${table}_record_insert AFTER INSERT ON ${table} BEGIN INSERT INTO record_order(entity,id) VALUES ('${table}',NEW.id); END;
          CREATE TRIGGER IF NOT EXISTS ${table}_record_delete AFTER DELETE ON ${table} BEGIN DELETE FROM record_order WHERE entity='${table}' AND id=OLD.id; END;
        `).join('\n')}
        ${counterSchema}
        ${fileStateSchema}
        ${checkpointSchema}
        ${counted ? '' : counterBackfill}
        PRAGMA user_version = 7;
        COMMIT;
      `);
      this.blobs = new BlobStore(this.directory, this.#db);
      this.knowledge = new KnowledgeRecords(this.#db);
      this.cases = new CaseRecords(this.#db);
      this.webRequests = new WebRequestRecords(this.#db);
      this.fileStates = new FileStateRecords(this.#db);
      this.checkpoints = new CheckpointRecords(this.#db);
      for (const file of readdirSync(path.join(this.directory, 'blobs'))) if (/^[a-f0-9]{64}(?:\.blob)?\.[0-9a-f-]{36}\.tmp$/.test(file)) unlinkSync(path.join(this.directory, 'blobs', file));
      this.transaction(() => {
        const sessions = (this.#db.prepare('SELECT data FROM sessions').all() as { data: string }[]).map(row => JSON.parse(row.data) as Session);
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
    this.assertWritable();
    if (this.pendingEvents) return action();
    this.pendingEvents = [];
    let result: T;
    let committed: RuntimeEvent[];
    try {
      result = this.#db.transaction(action)();
      committed = this.pendingEvents;
    } finally { this.pendingEvents = undefined; }
    // Delivery happens after COMMIT. Subscriber failures must never masquerade as a rollback.
    for (const event of committed) for (const listener of [...this.listeners]) {
      try { listener(event); }
      catch (error) {
        try {
          if (this.options.onSubscriberError) this.options.onSubscriberError({ event, error });
          else this.warnSubscriberError();
        } catch { this.warnSubscriberError(); }
      }
    }
    return result;
  }
  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  get fault(): unknown { return this.storageFailure; }
  /** A storage fault is an in-memory stop: publishing it never depends on another database write. */
  fail(error: unknown): void {
    if (this.storageFailure !== undefined) return;
    this.storageFailure = error ?? new KodoError('STORAGE_FAILED', 'storage is no longer writable');
    for (const listener of [...this.faultListeners]) {
      try { listener(this.storageFailure); } catch { this.warnSubscriberError(); }
    }
  }
  onFault(listener: (error: unknown) => void): () => void {
    this.faultListeners.add(listener);
    if (this.storageFailure !== undefined) listener(this.storageFailure);
    return () => this.faultListeners.delete(listener);
  }
  assertWritable(): void {
    if (this.storageFailure !== undefined) throw this.storageFailure;
    if (this.closed) throw new KodoError('STORAGE_CLOSED', 'storage is closed');
    try {
      const owner = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { token?: string };
      if (owner.token !== this.lockToken) throw new KodoError('LOCK_OWNER', 'data directory ownership changed');
    } catch (error) {
      const failure = error instanceof KodoError ? error : new KodoError('LOCK_OWNER', 'data directory ownership cannot be verified');
      this.fail(failure);
      throw failure;
    }
  }
/** Content-addressed and segmented: a growing context writes only its new messages. */
  blob(value: unknown): string {
    this.assertWritable();
    try { return this.blobs.write(value); }
    catch (error) { if (storageFault(error)) this.fail(error); throw error; }
  }
  readBlob<T>(ref: string): T { return this.blobs.read<T>(ref); }
  hasBlob(ref: string): boolean { return this.blobs.has(ref); }
  putSession(session: Session): void {
    this.#db.prepare('INSERT INTO sessions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(session.id, JSON.stringify(session));
  }
  session(id: string): Session {
    const session = this.row<Session>('sessions', id);
    // Old sessions retain the limits persisted at creation; missing windows used the old 256k default.
    const budget = { ...defaultBudget, ...session.budget, maxContextTokens: session.budget.maxContextTokens ?? 256_000 };
    if (session.budget.maxActiveChildren === undefined) {
      delete budget.maxActiveChildren;
      if (session.budget.maxChildren === undefined) budget.maxChildren = 8;
    }
    return { ...session, budget };
  }
  sessionsPage(options: PageOptions = {}): Page<Session> {
    const { after, limit } = pageBounds(options);
    const rows = this.#db.prepare("SELECT o.seq,s.id FROM record_order o JOIN sessions s ON s.id=o.id WHERE o.entity='sessions' AND o.seq>? ORDER BY o.seq LIMIT ?").all(after, limit + 1) as { seq: number; id: string }[];
    return pageOf(rows.map(row => ({ seq: row.seq, item: this.session(row.id) })), limit);
  }
  putRun(run: Run): void {
    this.#db.prepare('INSERT INTO runs VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data')
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
    return (this.#db.prepare(`SELECT data FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid`).all({ sessionId: sessionId ?? null, status: status ?? null }) as { data: string }[]).map(x => JSON.parse(x.data) as Run);
  }
  runsPage(options: PageOptions & { sessionId?: string; status?: Run['status'] } = {}): Page<Run> {
    const { after, limit } = pageBounds(options);
    const where = ["o.entity='runs'", 'o.seq>@after', options.sessionId !== undefined ? 'r.session_id=@sessionId' : '', options.status !== undefined ? 'r.status=@status' : ''].filter(Boolean);
    const rows = this.#db.prepare(`SELECT o.seq,r.data FROM record_order o JOIN runs r ON r.id=o.id WHERE ${where.join(' AND ')} ORDER BY o.seq LIMIT @limit`).all({ after, limit: limit + 1, sessionId: options.sessionId ?? null, status: options.status ?? null }) as { seq: number; data: string }[];
    return pageOf(rows.map(row => ({ seq: row.seq, item: JSON.parse(row.data) as Run })), limit);
  }
  putCall(call: Call): void {
    this.#db.prepare('INSERT INTO calls VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(call.id, call.runId, JSON.stringify(call));
  }
  call(id: string): Call { return this.row<Call>('calls', id); }
  calls(runId: string): Call[] {
    return (this.#db.prepare('SELECT data FROM calls WHERE run_id=? ORDER BY rowid').all(runId) as { data: string }[]).map(x => JSON.parse(x.data) as Call);
  }
  callsPage(runId: string, options: PageOptions = {}): Page<Call> {
    const { after, limit } = pageBounds(options);
    const rows = this.#db.prepare("SELECT o.seq,c.data FROM record_order o JOIN calls c ON c.id=o.id WHERE o.entity='calls' AND c.run_id=? AND o.seq>? ORDER BY o.seq LIMIT ?").all(runId, after, limit + 1) as { seq: number; data: string }[];
    return pageOf(rows.map(row => ({ seq: row.seq, item: JSON.parse(row.data) as Call })), limit);
  }
  recentModelCalls(runId: string, limit = 32): Call[] {
    pageBounds({ limit });
    return (this.#db.prepare("SELECT data FROM calls WHERE run_id=? AND json_extract(data,'$.kind')='model' AND json_extract(data,'$.status')='succeeded' ORDER BY rowid DESC LIMIT ?").all(runId, limit) as { data: string }[]).map(row => JSON.parse(row.data) as Call);
  }
  /**
   * Unresolved effects block writes to overlapping canonical workspaces across sessions.
   * With `roots`, only effects whose recorded roots overlap them count; legacy calls cover their whole workspace.
   */
  unresolvedWrites(workspace?: string, sessionId?: string, roots?: string[]): Call[] {
    const overlaps = (left: string, right: string): boolean => {
      const inside = (root: string, target: string): boolean => {
        const relative = path.relative(root, target);
        return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      };
      return inside(left, right) || inside(right, left);
    };
    const rows = this.#db.prepare(`SELECT c.data,r.status,s.data AS session FROM calls c JOIN runs r ON r.id=c.run_id JOIN sessions s ON s.id=r.session_id
      WHERE json_extract(c.data,'$.kind')='tool' AND json_extract(c.data,'$.effect')='write'
      AND json_extract(c.data,'$.status') IN ('unknown','running') ${sessionId ? 'AND r.session_id=@sessionId' : ''}`)
      .all({ sessionId: sessionId ?? null }) as { data: string; status: Run['status']; session: string }[];
    return rows.filter(row => !workspace || overlaps(workspace, (JSON.parse(row.session) as Session).workspace)).map(row => ({ row, call: JSON.parse(row.data) as Call })).filter(({ row, call }) => {
      if (roots && !(call.effectRoots ?? [(JSON.parse(row.session) as Session).workspace]).some(left => roots.some(right => overlaps(left, right)))) return false;
      if (call.status !== 'unknown' && (call.effectState === 'not_started' || call.effectAtomic || !['interrupted', 'failed', 'cancelled', 'completed'].includes(row.status))) return false;
      return !this.#db.prepare(`SELECT 1 FROM events WHERE run_id=? AND type='recovery.resolved' AND json_extract(data,'$.callId')=?
        AND seq>COALESCE((SELECT MAX(seq) FROM events WHERE run_id=? AND type='tool.started' AND json_extract(data,'$.callId')=?),0) LIMIT 1`).get(call.runId, call.id, call.runId, call.id);
    }).map(({ call }) => call);
  }
  registerCard(card: Card): void {
    const existing = this.#db.prepare('SELECT digest FROM card_versions WHERE id=? AND version=?').get(card.id, card.version) as { digest: string } | undefined;
    if (existing && existing.digest !== card.digest) throw new KodoError('CARD_CONFLICT', 'same card ID and version has different content');
    if (!existing) this.#db.prepare('INSERT INTO card_versions VALUES (?,?,?,?)').run(card.id, card.version, card.digest, JSON.stringify(card));
  }
  card(id: string, version: string): Card {
    const row = this.#db.prepare('SELECT data FROM card_versions WHERE id=? AND version=?').get(id, version) as { data: string } | undefined;
    if (!row) throw new KodoError('CARD_NOT_FOUND', 'card version is not registered');
    return JSON.parse(row.data) as Card;
  }
  registeredCards(): Card[] {
    return (this.#db.prepare('SELECT data FROM card_versions ORDER BY id,version').all() as { data: string }[]).map(row => JSON.parse(row.data) as Card);
  }
  artifact(runId: string, ref: string): string {
    const id = randomUUID();
    this.#db.prepare('INSERT INTO artifacts(id,run_id,ref,decision_version) VALUES (?,?,?,?)').run(id, runId, ref, this.run(runId).decisionVersion ?? 0);
    return id;
  }
  /** Artifact provenance of a session in creation order; contents stay behind readArtifact. */
  artifactIds(sessionId: string): { id: string; runId: string; decisionVersion: number }[] {
    return this.#db.prepare('SELECT a.id,a.run_id AS runId,a.decision_version AS decisionVersion FROM artifacts a JOIN runs r ON r.id=a.run_id WHERE r.session_id=? ORDER BY a.rowid').all(sessionId) as { id: string; runId: string; decisionVersion: number }[];
  }
  readArtifact(runId: string, id: string): unknown {
    const run = this.run(runId);
    const row = this.#db.prepare('SELECT a.ref,a.run_id,a.decision_version FROM artifacts a JOIN runs r ON r.id=a.run_id WHERE a.id=? AND r.session_id=?').get(id, run.sessionId) as { ref: string; run_id: string; decision_version: number } | undefined;
    if (!row) throw new KodoError('ARTIFACT_DENIED', 'artifact does not belong to this session');
    const value = this.readBlob<unknown>(row.ref);
    return { ...(typeof value === 'object' && value !== null && !Array.isArray(value) ? value : { value }), provenance: { runId: row.run_id, decisionVersion: row.decision_version, stale: row.decision_version < (this.session(run.sessionId).decisionVersion ?? 0) } };
  }
  message(id: string): Envelope | undefined {
    const row = this.#db.prepare('SELECT seq,data FROM messages WHERE id=?').get(id) as { seq: number; data: string } | undefined;
    return row ? { ...JSON.parse(row.data) as Envelope, seq: row.seq } : undefined;
  }
  putMessage(message: Omit<Envelope, 'seq'>): Envelope {
    const previous = this.message(message.id);
    if (previous) {
      if (JSON.stringify({ ...previous, seq: undefined }) !== JSON.stringify(message)) throw new KodoError('MESSAGE_CONFLICT', 'message ID was reused with different content');
      return previous;
    }
    const row = this.#db.prepare('INSERT INTO messages(id,session_id,recipient,data) VALUES (?,?,?,?)').run(message.id, message.sessionId, message.to, JSON.stringify(message));
    const result = { ...message, seq: Number(row.lastInsertRowid) };
    this.event(message.to === 'user' ? message.from : message.to, 'message.created', { messageId: result.id, messageSeq: result.seq });
    return result;
  }
  messages(sessionId: string): Envelope[] {
    return (this.#db.prepare('SELECT seq,data FROM messages WHERE session_id=? ORDER BY seq').all(sessionId) as { seq: number; data: string }[])
      .map(row => ({ ...JSON.parse(row.data) as Envelope, seq: row.seq }));
  }
  messagesPage(sessionId: string, options: PageOptions & { recipient?: string } = {}): Page<Envelope> {
    const { after, limit } = pageBounds(options);
    const rows = this.#db.prepare(`SELECT seq,data FROM messages WHERE session_id=@sessionId AND seq>@after ${options.recipient !== undefined ? 'AND recipient=@recipient' : ''} ORDER BY seq LIMIT @limit`).all({ sessionId, after, limit: limit + 1, recipient: options.recipient ?? null }) as { seq: number; data: string }[];
    return pageOf(rows.map(row => ({ seq: row.seq, item: { ...JSON.parse(row.data) as Envelope, seq: row.seq } })), limit);
  }
  inbox(runId: string): Envelope[] {
    const run = this.run(runId);
    return (this.#db.prepare('SELECT seq,data FROM messages WHERE recipient=? AND seq>? ORDER BY seq').all(runId, run.inputCursor ?? 0) as { seq: number; data: string }[]).map(row => ({ ...JSON.parse(row.data) as Envelope, seq: row.seq }));
  }
  countInbox(runId: string): number {
    const run = this.run(runId);
    return (this.#db.prepare('SELECT count(*) AS count FROM messages WHERE recipient=? AND seq>?').get(runId, run.inputCursor ?? 0) as { count: number }).count;
  }
  answer(questionId: string): Envelope | undefined {
    const row = this.#db.prepare("SELECT seq,data FROM messages WHERE json_extract(data,'$.replyTo')=? AND json_extract(data,'$.kind')='answer' ORDER BY seq LIMIT 1").get(questionId) as { seq: number; data: string } | undefined;
    return row ? { ...JSON.parse(row.data) as Envelope, seq: row.seq } : undefined;
  }
  unansweredQuestions(sessionId: string, recipient?: string): Envelope[] {
    const rows = this.#db.prepare(`SELECT m.seq,m.data FROM messages m WHERE m.session_id=@sessionId ${recipient ? 'AND m.recipient=@recipient' : ''}
      AND json_extract(m.data,'$.kind')='question' AND NOT EXISTS (SELECT 1 FROM messages a WHERE json_extract(a.data,'$.replyTo')=m.id AND json_extract(a.data,'$.kind')='answer') ORDER BY m.seq`)
      .all({ sessionId, recipient: recipient ?? null }) as { seq: number; data: string }[];
    return rows.map(row => ({ ...JSON.parse(row.data) as Envelope, seq: row.seq }));
  }
  putWait(wait: Wait): void {
    this.#db.prepare('INSERT INTO waits VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(wait.id, wait.runId, JSON.stringify(wait));
  }
  wait(id: string): Wait {
    const row = this.#db.prepare('SELECT data FROM waits WHERE id=?').get(id) as { data: string } | undefined;
    if (!row) throw new KodoError('WAIT_NOT_FOUND', 'wait record not found');
    return JSON.parse(row.data) as Wait;
  }
  waits(sessionId?: string, registeredOnly = false): Wait[] {
    return (this.#db.prepare(`SELECT w.data FROM waits w JOIN runs r ON r.id=w.run_id WHERE (@sessionId IS NULL OR r.session_id=@sessionId) ${registeredOnly ? "AND json_extract(w.data,'$.status')='registered'" : ''}`).all({ sessionId: sessionId ?? null }) as { data: string }[]).map(x => JSON.parse(x.data) as Wait);
  }
  /**
   * Read-only probe for tables that only the deleted roster, draft and derived-agent
   * subsystems wrote. This build never creates or reads them, but a data directory
   * written by an older build may still contain matching rows for a session.
   */
  legacyAgentSession(sessionId: string): boolean {
    const has = (table: string): boolean => Boolean(this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
    if (has('roster_snapshots') && this.#db.prepare('SELECT 1 FROM roster_snapshots WHERE session_id=? LIMIT 1').get(sessionId)) return true;
    if (has('derived_agents') && this.#db.prepare('SELECT 1 FROM derived_agents WHERE session_id=? LIMIT 1').get(sessionId)) return true;
    if (has('agent_drafts') && this.#db.prepare('SELECT 1 FROM agent_drafts WHERE session_id=? LIMIT 1').get(sessionId)) return true;
    return false;
  }
  /** Exclusive directory ownership makes mark/sweep safe between runtime operations. */
  gc(options: { vacuum?: boolean; olderThanDays?: number } = {}): { removedBlobs: number; freedBytes: number; removedSessions: number } {
    if (this.#db.inTransaction || this.listRuns(undefined, 'running').length) throw new KodoError('GC_ACTIVE', 'stop active execution before garbage collection');
    if (options.olderThanDays !== undefined && (!Number.isSafeInteger(options.olderThanDays) || options.olderThanDays < 1)) throw new KodoError('GC_RETENTION', 'olderThanDays must be a positive integer');
    const hasCaseRuns = Boolean(this.#db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='case_runs'").get());
    // Retained case evidence owns its execution history, including failed and interrupted attempts.
    const caseSessions = new Set(hasCaseRuns ? (this.#db.prepare("SELECT DISTINCT r.session_id FROM runs r JOIN case_runs c ON r.id=json_extract(c.data,'$.execution.runId')").all() as { session_id: string }[]).map(row => row.session_id) : []);
    let removedSessions = 0;
    if (options.olderThanDays !== undefined) this.transaction(() => {
      const cutoff = Date.now() - options.olderThanDays! * 86_400_000;
      const sessions = this.#db.prepare('SELECT data FROM sessions').all() as { data: string }[];
      for (const row of sessions) {
        const session = JSON.parse(row.data) as Session;
        const runs = this.listRuns(session.id);
        if (caseSessions.has(session.id) || session.activeSince !== undefined || Date.parse(session.createdAt) >= cutoff || runs.some(run => !['completed', 'failed', 'cancelled'].includes(run.status)) || this.unresolvedWrites(undefined, session.id).length) continue;
        // Retention is measured from the last activity, not merely session creation.
        const latest = this.#db.prepare('SELECT MAX(time) AS time FROM events WHERE session_id=?').get(session.id) as { time: string | null };
        if (latest.time && Date.parse(latest.time) >= cutoff) continue;
        // Unbound partial findings remain session-private; they have no independent source excerpt to retain.
        this.#db.prepare(`DELETE FROM knowledge_uses WHERE (project_id,id,revision) IN
          (SELECT k.project_id,k.id,k.revision FROM knowledge_versions k JOIN runs r ON r.id=k.source_run_id WHERE r.session_id=? AND json_array_length(k.data,'$.scope')=0)`).run(session.id);
        this.#db.prepare(`DELETE FROM knowledge_versions WHERE source_run_id IN (SELECT id FROM runs WHERE session_id=?) AND json_array_length(data,'$.scope')=0`).run(session.id);
        for (const run of runs) {
          for (const table of ['calls', 'artifacts', 'waits', 'events', 'file_states', 'file_checkpoints', 'file_checkpoint_floors']) this.#db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(run.id);
        }
        for (const table of ['messages', 'decisions', 'runs']) this.#db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(session.id);
        this.#db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
        removedSessions++;
      }
    });
    const marked = new Set<string>();
    const queue: string[] = [];
    const mark = (content: string): void => {
      for (const ref of content.match(/[a-f0-9]{64}/g) ?? []) if (!marked.has(ref)) { marked.add(ref); queue.push(ref); }
    };
    for (const table of ['sessions', 'runs', 'calls', 'card_versions', 'artifacts', 'events', 'messages', 'waits', 'decisions', 'knowledge_versions', 'file_checkpoints', 'agent_drafts', ...(hasCaseRuns ? ['case_runs'] : [])]) {
      for (const row of this.#db.prepare(`SELECT * FROM ${table}`).iterate()) mark(JSON.stringify(row));
    }
    // References can be nested inside archived snapshots, JSON message strings or segment manifests.
    for (let index = 0; index < queue.length; index++) {
      const raw = this.blobs.raw(queue[index]!);
      if (raw !== undefined) mark(raw);
    }
    const { removed: removedBlobs, freedBytes } = this.blobs.sweep(marked);
    if (options.vacuum) { this.#db.pragma('wal_checkpoint(TRUNCATE)'); this.#db.exec('VACUUM'); }
    return { removedBlobs, freedBytes, removedSessions };
  }
  putDecision(sessionId: string, version: number, content: string): void {
    this.#db.prepare('INSERT INTO decisions VALUES (?,?,?)').run(sessionId, version, JSON.stringify({ content }));
  }
  decisions(sessionId: string): { version: number; content: string }[] {
    return (this.#db.prepare('SELECT version,data FROM decisions WHERE session_id=? ORDER BY version').all(sessionId) as { version: number; data: string }[])
      .map(x => ({ version: x.version, ...JSON.parse(x.data) as { content: string } }));
  }
  event(runId: string, type: string, data: Record<string, unknown> = {}): void {
    if (!this.pendingEvents) return this.transaction(() => this.event(runId, type, data));
    const run = this.run(runId);
    const time = new Date().toISOString();
    const row = this.#db.prepare('INSERT INTO events(session_id,run_id,type,time,data) VALUES (?,?,?,?,?)').run(run.sessionId, runId, type, time, JSON.stringify(data));
    this.pendingEvents.push({ seq: Number(row.lastInsertRowid), sessionId: run.sessionId, runId, type, time, version: 1, data });
  }
  /** Events of a run in order; a filter narrows by seq, type and top-level data fields using the indexes. */
  events(runId: string, filter: number | EventFilter = 0): RuntimeEvent[] {
    return selectEvents(this.#db, runId, typeof filter === 'number' ? { after: filter } : filter);
  }
  latestEvent(runId: string, filter: EventFilter = {}): RuntimeEvent | undefined {
    return selectEvents(this.#db, runId, filter, 'DESC', 1)[0];
  }
  hasEvent(runId: string, filter: EventFilter = {}): boolean {
    return selectEvents(this.#db, runId, filter, 'ASC', 1).length > 0;
  }
  /** Type-only counts come from materialized counters; other filters use the event indexes. */
  countEvents(runId: string, filter: EventFilter = {}): number { return countEvents(this.#db, runId, filter); }
  /** Materialized per-run call counts by kind, name, status and effect. */
  countCalls(runId: string, filter: CallCountFilter = {}): number { return countCalls(this.#db, runId, filter); }
  queryCalls(runId: string, filter: CallQueryFilter = {}): Call[] { return queryCalls(this.#db, runId, filter); }
  latestEventSeq(runId: string): number { return latestEventSeq(this.#db, runId); }
  eventsPage(options: PageOptions & { sessionId?: string; runId?: string } = {}): Page<RuntimeEvent> {
    const { after, limit } = pageBounds(options);
    const where = ['seq>@after', options.sessionId !== undefined ? 'session_id=@sessionId' : '', options.runId !== undefined ? 'run_id=@runId' : ''].filter(Boolean);
    const rows = this.#db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT @limit`).all({ after, limit: limit + 1, sessionId: options.sessionId ?? null, runId: options.runId ?? null }) as StoredEvent[];
    return pageOf(rows.map(row => ({ seq: row.seq, item: eventFromRow(row) })), limit);
  }
  /** SQLite structural integrity check; 'ok' when the database is sound. */
  quickCheck(): unknown { return this.#db.pragma('quick_check', { simple: true }); }
  probeSearch(): boolean {
    this.#db.exec("CREATE VIRTUAL TABLE temp.search_probe USING fts5(text, tokenize='trigram'); INSERT INTO temp.search_probe VALUES ('数据库分析员');");
    try { return Boolean(this.#db.prepare("SELECT rowid FROM temp.search_probe WHERE text MATCH ?").get('数据库')); }
    finally { this.#db.exec('DROP TABLE temp.search_probe'); }
  }
  close(): void {
    if (this.closed) return;
    this.#db.close();
    this.releaseLock();
    this.closed = true;
  }
  private row<T>(table: 'sessions' | 'runs' | 'calls', id: string): T {
    const row = this.#db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as { data: string } | undefined;
    if (!row) throw new KodoError('NOT_FOUND', `${table} record not found`);
    return JSON.parse(row.data) as T;
  }
  private warnSubscriberError(): void {
    process.emitWarning('A runtime event subscriber failed after commit; persisted state remains committed.', { code: 'KODO_SUBSCRIBER_ERROR' });
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
