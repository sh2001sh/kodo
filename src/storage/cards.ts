import type Database from 'better-sqlite3';
import type { RosterMember, RosterSnapshot } from '../agents/roster.js';
import { KodoError } from '../runtime/types.js';

/** Validated card metadata selection; `fetch` rows are returned so callers can detect a next page. */
export interface CardQuery { query: string; tools: string[]; skills: string[]; offset: number; fetch: number }
export interface CardNamespace { namespace: string; agents: number; versions: number }
export interface ExplorationUsage { calls: number; cards: number; maxCalls: number | null; maxCards: number | null }
export interface RosterQuery { sessionId: string; query?: string; path?: string; mode?: string; tools?: string[]; skills?: string[]; mcp?: string[]; availability?: 'available' | 'unavailable'; offset?: number; fetch?: number }

const indexSql = `
  CREATE VIRTUAL TABLE IF NOT EXISTS agent_metadata_fts USING fts5(id,name,description,tools,skills,tokenize='trigram');
  CREATE TRIGGER IF NOT EXISTS agent_metadata_insert AFTER INSERT ON card_versions BEGIN
    INSERT INTO agent_metadata_fts(rowid,id,name,description,tools,skills) VALUES (NEW.rowid,NEW.id,json_extract(NEW.data,'$.name'),coalesce(json_extract(NEW.data,'$.description'),''),json_extract(NEW.data,'$.tools'),coalesce(json_extract(NEW.data,'$.skills'),''));
  END;
  CREATE TRIGGER IF NOT EXISTS agent_metadata_delete AFTER DELETE ON card_versions BEGIN
    DELETE FROM agent_metadata_fts WHERE rowid=OLD.rowid;
  END;
  CREATE TRIGGER IF NOT EXISTS agent_metadata_update AFTER UPDATE ON card_versions BEGIN
    DELETE FROM agent_metadata_fts WHERE rowid=OLD.rowid;
    INSERT INTO agent_metadata_fts(rowid,id,name,description,tools,skills) VALUES (NEW.rowid,NEW.id,json_extract(NEW.data,'$.name'),coalesce(json_extract(NEW.data,'$.description'),''),json_extract(NEW.data,'$.tools'),coalesce(json_extract(NEW.data,'$.skills'),''));
  END;
`;
const metadata = "c.id || ' ' || coalesce(json_extract(c.data,'$.name'),'') || ' ' || coalesce(json_extract(c.data,'$.description'),'') || ' ' || coalesce((SELECT group_concat(value,' ') FROM json_each(c.data,'$.tools')),'') || ' ' || coalesce((SELECT group_concat(value,' ') FROM json_each(c.data,'$.skills')),'')";

function filters(tools: string[], skills: string[]): { conditions: string[]; values: (string | number)[] } {
  const conditions: string[] = [];
  const values: (string | number)[] = [];
  for (const [field, names] of [['tools', tools], ['skills', skills]] as const) for (const name of names) {
    conditions.push(`EXISTS (SELECT 1 FROM json_each(c.data,'$.${field}') WHERE value=?)`);
    values.push(name);
  }
  return { conditions, values };
}

/** Agent metadata retrieval over card versions. Derived metadata only: private prompts never enter the index. */
export class CardRecords {
  private indexed = false;
  private rosterReady = false;
  constructor(private readonly db: Database.Database) {}

  private ensureRoster(): void {
    // Initial schema creation may have belonged to a caller transaction that rolled back.
    if (this.rosterReady && this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='roster_snapshots'").get()) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS roster_snapshots(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,digest TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS roster_members(seq INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL REFERENCES roster_snapshots(session_id) ON DELETE CASCADE,id TEXT NOT NULL,version TEXT NOT NULL,digest TEXT NOT NULL,catalog_path TEXT NOT NULL,availability TEXT NOT NULL,ordinal INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(session_id,id));
      CREATE INDEX IF NOT EXISTS roster_members_path ON roster_members(session_id,catalog_path,ordinal);
      CREATE VIRTUAL TABLE IF NOT EXISTS roster_metadata_fts USING fts5(id,name,description,routing,aliases,tools,skills,mcp,tokenize='trigram');
      CREATE TRIGGER IF NOT EXISTS roster_member_delete AFTER DELETE ON roster_members BEGIN DELETE FROM roster_metadata_fts WHERE rowid=OLD.seq; END;
      CREATE TABLE IF NOT EXISTS roster_discovery_seen(session_id TEXT NOT NULL REFERENCES roster_snapshots(session_id) ON DELETE CASCADE,id TEXT NOT NULL,version TEXT NOT NULL,PRIMARY KEY(session_id,id,version)) WITHOUT ROWID;
    `);
    this.rosterReady = true;
  }
  freezeRoster(snapshot: RosterSnapshot, expectedDigest?: string): void {
    this.ensureRoster();
    this.db.transaction(() => {
      const old = this.db.prepare('SELECT digest FROM roster_snapshots WHERE session_id=?').get(snapshot.sessionId) as { digest: string } | undefined;
      if (expectedDigest !== undefined && old?.digest !== expectedDigest) throw new KodoError('ROSTER_CHANGED', 'roster revision changed before publication');
      if (old && expectedDigest === undefined) { if (old.digest !== snapshot.digest) throw new KodoError('ROSTER_FROZEN', 'the session roster is already frozen'); return; }
      if (old) {
        this.db.prepare('DELETE FROM roster_members WHERE session_id=?').run(snapshot.sessionId);
        this.db.prepare('DELETE FROM roster_snapshots WHERE session_id=?').run(snapshot.sessionId);
      }
      this.db.prepare('INSERT INTO roster_snapshots VALUES (?,?,?)').run(snapshot.sessionId, snapshot.digest, JSON.stringify(snapshot));
      const insert = this.db.prepare('INSERT INTO roster_members(session_id,id,version,digest,catalog_path,availability,ordinal,data) VALUES (?,?,?,?,?,?,?,?)');
      const index = this.db.prepare('INSERT INTO roster_metadata_fts(rowid,id,name,description,routing,aliases,tools,skills,mcp) VALUES (?,?,?,?,?,?,?,?,?)');
      snapshot.members.forEach((member, ordinal) => {
        const card = member.card;
        const row = insert.run(snapshot.sessionId, card.id, card.version, card.digest, member.catalogPath, member.availability, ordinal, JSON.stringify(member));
        index.run(row.lastInsertRowid, card.id, card.name, card.description ?? '', [...(card.routing?.use_when ?? []), ...(card.routing?.not_for ?? [])].join(' '), (card.catalog?.aliases ?? []).join(' '), card.tools.join(' '), (card.skills ?? []).join(' '), (card.mcp ?? []).map(server => server.server).join(' '));
      });
    })();
  }
  rosterSnapshot(sessionId: string): RosterSnapshot | undefined {
    this.ensureRoster();
    const row = this.db.prepare('SELECT data FROM roster_snapshots WHERE session_id=?').get(sessionId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as RosterSnapshot : undefined;
  }
  rosterMember(sessionId: string, id: string, version?: string): RosterMember | undefined {
    this.ensureRoster();
    const row = this.db.prepare(`SELECT m.data FROM roster_members m JOIN roster_snapshots s ON s.session_id=m.session_id WHERE m.session_id=? AND m.id=?${version === undefined ? '' : ' AND m.version=?'}`).get(sessionId, id, ...(version === undefined ? [] : [version])) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as RosterMember : undefined;
  }
  /** All structural filters apply to this same member row before metadata ranking. */
  rosterSearch(options: RosterQuery): RosterMember[] {
    this.ensureRoster();
    const conditions = ['m.session_id=?'], values: (string | number)[] = [options.sessionId];
    if (options.path) { conditions.push("(m.catalog_path=? OR substr(m.catalog_path,1,length(?)+1)=?||'/')"); values.push(options.path, options.path, options.path); }
    if (options.mode) { conditions.push("json_extract(m.data,'$.card.routing.mode')=?"); values.push(options.mode); }
    if (options.availability) { conditions.push('m.availability=?'); values.push(options.availability); }
    for (const [field, required] of [['tools', options.tools], ['skills', options.skills]] as const) for (const name of required ?? []) { conditions.push(`EXISTS(SELECT 1 FROM json_each(m.data,'$.card.${field}') WHERE value=?)`); values.push(name); }
    for (const name of options.mcp ?? []) { conditions.push("EXISTS(SELECT 1 FROM json_each(m.data,'$.card.mcp') WHERE json_extract(value,'$.server')=?)"); values.push(name); }
    const terms = [...new Set((options.query ?? '').trim().split(/\s+/u).filter(Boolean))];
    const long = terms.filter(term => [...term].length >= 3);
    if (long.length) { conditions.push('roster_metadata_fts MATCH ?'); values.push(long.map(term => `"${term.replaceAll('"', '""')}"`).join(' AND ')); }
    for (const term of terms.filter(term => [...term].length < 3)) { conditions.push("instr(lower(roster_metadata_fts.id||' '||name||' '||description||' '||routing||' '||aliases||' '||tools||' '||skills||' '||mcp),lower(?))>0"); values.push(term); }
    const rows = this.db.prepare(`SELECT m.data FROM roster_members m JOIN roster_snapshots s ON s.session_id=m.session_id JOIN roster_metadata_fts ON roster_metadata_fts.rowid=m.seq WHERE ${conditions.join(' AND ')} ORDER BY ${long.length ? 'bm25(roster_metadata_fts,8,6,2,10,8,3,3,3),' : ''}m.ordinal LIMIT ? OFFSET ?`).all(...values, options.fetch ?? -1, options.offset ?? 0) as { data: string }[];
    return rows.map(row => JSON.parse(row.data) as RosterMember);
  }
  seenRosterMembers(sessionId: string): Set<string> {
    this.ensureRoster();
    return new Set((this.db.prepare('SELECT id,version FROM roster_discovery_seen WHERE session_id=?').all(sessionId) as { id: string; version: string }[]).map(row => `${row.id}@${row.version}`));
  }
  recordRosterMembers(sessionId: string, cards: readonly { id: string; version: string }[]): number {
    this.ensureRoster();
    const insert = this.db.prepare('INSERT OR IGNORE INTO roster_discovery_seen VALUES (?,?,?)');
    return cards.reduce((count, card) => count + insert.run(sessionId, card.id, card.version).changes, 0);
  }
  rosterExploredPaths(sessionId: string): string[] {
    return (this.db.prepare("SELECT DISTINCT coalesce(json_extract(data,'$.path'),'') AS path FROM events WHERE session_id=? AND type='agent.discovery.explored'").all(sessionId) as { path: string }[]).map(row => row.path).sort();
  }

  /** Creates the FTS index once per database; triggers cover later registrations. */
  ensureIndex(): void {
    const present = (): boolean => Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_metadata_fts'").get());
    if (this.indexed && present()) return;
    this.db.transaction(() => {
      const exists = present();
      this.db.exec(indexSql);
      if (!exists) this.db.exec(`INSERT INTO agent_metadata_fts(rowid,id,name,description,tools,skills)
        SELECT rowid,id,json_extract(data,'$.name'),coalesce(json_extract(data,'$.description'),''),json_extract(data,'$.tools'),coalesce(json_extract(data,'$.skills'),'') FROM card_versions`);
    })();
    this.indexed = true;
  }

  /** Ranked multi-term search; returns serialized card data rows. */
  search(options: CardQuery, sessionId?: string): string[] {
    if (sessionId === undefined) this.ensureIndex(); else this.ensureRoster();
    const index = sessionId === undefined ? 'agent_metadata_fts' : 'roster_metadata_fts';
    const scoped = this.frozenVersions(sessionId, true);
    const { query, offset, fetch } = options;
    const { conditions, values } = filters(options.tools, options.skills);
    const terms = [...new Set(query.split(/\s+/u).filter(Boolean))];
    const long = terms.filter(term => [...term].length >= 3);
    const short = terms.filter(term => [...term].length < 3);
    if (long.length) {
      conditions.push(`${index} MATCH ?`);
      // Treat all input as phrases, never as FTS operators or SQL. Different terms may match different fields.
      values.push(long.map(term => `${sessionId === undefined ? '' : '{id name description tools skills}: '}"${term.replaceAll('"', '""')}"`).join(' AND '));
    }
    for (const term of short) {
      // FTS5 trigram cannot retrieve one/two-codepoint queries. Literal containment also covers Chinese.
      conditions.push(`instr(lower(${metadata}),lower(?))>0`);
      values.push(term);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const relevance = query ? `CASE WHEN lower(c.id)=lower(?) THEN 0 WHEN lower(json_extract(c.data,'$.name'))=lower(?) THEN 1 WHEN instr(lower(c.id),lower(?))=1 THEN 2 ELSE 3 END,` : '';
    const weights = sessionId === undefined ? '12.0,8.0,2.0,3.0,3.0' : '12.0,8.0,2.0,0.0,0.0,3.0,3.0,0.0';
    const rank = long.length ? `CASE WHEN instr(lower(c.id),lower(?))=1 THEN 0 ELSE bm25(${index},${weights}) END,` : '';
    const rows = this.db.prepare(`${scoped.sql} SELECT c.data FROM card_versions c ${long.length ? `JOIN ${index} ON ${index}.rowid=c.rowid` : ''}
      ${where} ORDER BY ${relevance}${rank}c.id COLLATE BINARY,c.version COLLATE BINARY LIMIT ? OFFSET ?`)
      .all(...scoped.values, ...values, ...(query ? [query, query, query] : []), ...(long.length ? [query] : []), fetch, offset) as { data: string }[];
    return rows.map(row => row.data);
  }

  /** One page of publisher namespaces, plus whether another page exists. */
  namespaces(options: Omit<CardQuery, 'query'> & { namespace?: string; limit: number }, sessionId?: string): { namespaces: CardNamespace[]; more: boolean } {
    const scoped = this.frozenVersions(sessionId);
    const { conditions, values } = this.directoryFilters(options);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    // The namespace list is paged too: a large installation cannot produce an unbounded directory.
    const namespaces = this.db.prepare(`${scoped.sql} SELECT substr(c.id,1,instr(c.id,'/')-1) AS namespace,count(DISTINCT c.id) AS agents,count(*) AS versions
      FROM card_versions c ${where} GROUP BY namespace ORDER BY namespace COLLATE BINARY LIMIT ? OFFSET ?`).all(...scoped.values, ...values, options.limit, options.namespace === undefined ? options.offset : 0) as CardNamespace[];
    const more = options.namespace === undefined && Boolean(this.db.prepare(`${scoped.sql} SELECT 1 FROM card_versions c ${where} GROUP BY substr(c.id,1,instr(c.id,'/')-1) LIMIT 1 OFFSET ?`).get(...scoped.values, ...values, options.offset + options.limit));
    return { namespaces, more };
  }

  /** Card versions of one namespace in id/version order; returns serialized card data rows. */
  namespaceCards(options: Omit<CardQuery, 'query'> & { namespace: string }, sessionId?: string): string[] {
    const scoped = this.frozenVersions(sessionId);
    const { conditions, values } = this.directoryFilters(options);
    const rows = this.db.prepare(`${scoped.sql} SELECT c.data FROM card_versions c WHERE ${conditions.join(' AND ')} ORDER BY c.id COLLATE BINARY,c.version COLLATE BINARY LIMIT ? OFFSET ?`).all(...scoped.values, ...values, options.fetch, options.offset) as { data: string }[];
    return rows.map(row => row.data);
  }

  /** Reuse legacy selection/order against frozen rows without reading live registry versions. */
  private frozenVersions(sessionId?: string, availableOnly = false): { sql: string; values: string[] } {
    if (sessionId === undefined) return { sql: '', values: [] };
    this.ensureRoster();
    return { sql: `WITH card_versions AS (SELECT m.seq AS rowid,m.id,m.version,json_extract(m.data,'$.card') AS data FROM roster_members m JOIN roster_snapshots s ON s.session_id=m.session_id WHERE m.session_id=?${availableOnly ? " AND m.availability='available'" : ''})`, values: [sessionId] };
  }

  /** Discovery calls, candidates and the tightest limits recorded so far in a session. */
  explorationUsage(sessionId: string): ExplorationUsage {
    return this.db.prepare("SELECT count(*) AS calls,coalesce(sum(json_extract(data,'$.cards')),0) AS cards,min(json_extract(data,'$.maxCalls')) AS maxCalls,min(json_extract(data,'$.maxCards')) AS maxCards FROM events WHERE session_id=? AND type='agent.discovery.explored'").get(sessionId) as ExplorationUsage;
  }

  private directoryFilters(options: { tools: string[]; skills: string[]; namespace?: string }): { conditions: string[]; values: (string | number)[] } {
    const result = filters(options.tools, options.skills);
    if (options.namespace !== undefined) {
      result.conditions.push("substr(c.id,1,instr(c.id,'/')-1)=?");
      result.values.push(options.namespace);
    }
    return result;
  }
}
