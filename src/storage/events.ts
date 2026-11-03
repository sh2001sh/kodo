import type Database from 'better-sqlite3';
import type { Call, RuntimeEvent } from '../runtime/types.js';
import { KodoError } from '../runtime/types.js';

/** Scalar equality on top-level event data fields; JSON types must match exactly (`1` never matches `true`). */
export type EventMatch = Record<string, string | number | boolean | null>;
/** Indexed event selection for one run: `(run_id, type, seq)` serves type filters, `(run_id, seq)` the rest. */
export interface EventFilter { after?: number; types?: readonly string[]; typePrefix?: string; match?: EventMatch }
/** Call counter selection; array fields match any listed value. */
export interface CallCountFilter { kind?: string; name?: string | readonly string[]; status?: string | readonly string[]; effect?: string | readonly string[]; requestRef?: string }
export interface CallQueryFilter extends CallCountFilter { limit?: number; statusOrder?: readonly Call['status'][] }
export type StoredEvent = { seq: number; session_id: string; run_id: string; type: string; time: string; data: string };

export const eventFromRow = (row: StoredEvent): RuntimeEvent => ({ seq: row.seq, sessionId: row.session_id, runId: row.run_id, type: row.type, time: row.time, version: 1, data: JSON.parse(row.data) as Record<string, unknown> });

const callColumns = ['kind', 'name', 'status', 'effect'] as const;
const callKey = (row: 'NEW' | 'OLD'): string => `${row}.run_id,${callColumns.map(column => `coalesce(json_extract(${row}.data,'$.${column}'),'')`).join(',')}`;
const callIncrement = (row: 'NEW' | 'OLD'): string => `INSERT INTO call_counts(run_id,kind,name,status,effect,count) VALUES (${callKey(row)},1)
  ON CONFLICT(run_id,kind,name,status,effect) DO UPDATE SET count=count+1;`;
const callDecrement = (row: 'NEW' | 'OLD'): string => `UPDATE call_counts SET count=count-1 WHERE (run_id,kind,name,status,effect)=(${callKey(row)});
  DELETE FROM call_counts WHERE (run_id,kind,name,status,effect)=(${callKey(row)}) AND count<=0;`;

/**
 * Counters maintained by triggers inside the writing transaction, so they cannot
 * drift from the rows they count: events per (run, type) with the latest seq, and
 * calls per (run, kind, name, status, effect).
 */
export const counterSchema = `
  CREATE INDEX IF NOT EXISTS events_type ON events(run_id,type,seq);
  CREATE INDEX IF NOT EXISTS calls_request ON calls(run_id,json_extract(data,'$.requestRef'),json_extract(data,'$.kind'));
  CREATE INDEX IF NOT EXISTS calls_state_step ON calls(run_id,json_extract(data,'$.kind'),json_extract(data,'$.status'),json_extract(data,'$.step') DESC);
  CREATE TABLE IF NOT EXISTS event_counts(run_id TEXT NOT NULL, type TEXT NOT NULL, count INTEGER NOT NULL, last_seq INTEGER NOT NULL, PRIMARY KEY(run_id,type)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS call_counts(run_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, effect TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(run_id,kind,name,status,effect)) WITHOUT ROWID;
  CREATE TRIGGER IF NOT EXISTS event_counts_insert AFTER INSERT ON events BEGIN
    INSERT INTO event_counts(run_id,type,count,last_seq) VALUES (NEW.run_id,NEW.type,1,NEW.seq)
      ON CONFLICT(run_id,type) DO UPDATE SET count=count+1,last_seq=max(last_seq,excluded.last_seq);
  END;
  CREATE TRIGGER IF NOT EXISTS event_counts_delete AFTER DELETE ON events BEGIN
    UPDATE event_counts SET count=count-1 WHERE run_id=OLD.run_id AND type=OLD.type;
    DELETE FROM event_counts WHERE run_id=OLD.run_id AND type=OLD.type AND count<=0;
  END;
  CREATE TRIGGER IF NOT EXISTS call_counts_insert AFTER INSERT ON calls BEGIN ${callIncrement('NEW')} END;
  CREATE TRIGGER IF NOT EXISTS call_counts_update AFTER UPDATE OF data ON calls BEGIN ${callDecrement('OLD')} ${callIncrement('NEW')} END;
  CREATE TRIGGER IF NOT EXISTS call_counts_delete AFTER DELETE ON calls BEGIN ${callDecrement('OLD')} END;
`;

/** Rebuilds both counter tables from their rows; run once when a database first gains them. */
export const counterBackfill = `
  DELETE FROM event_counts;
  INSERT INTO event_counts(run_id,type,count,last_seq) SELECT run_id,type,count(*),max(seq) FROM events GROUP BY run_id,type;
  DELETE FROM call_counts;
  INSERT INTO call_counts(run_id,kind,name,status,effect,count) SELECT ${callKey('NEW').replace(/NEW\./g, '')},count(*) FROM calls GROUP BY 1,2,3,4,5;
`;

const fieldName = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const placeholders = (values: readonly unknown[]): string => values.map(() => '?').join(',');
const statements = new WeakMap<Database.Database, Map<string, Database.Statement>>();

/** Filter shapes repeat every step; compile each distinct SQL text once per connection. */
function statement(db: Database.Database, sql: string): Database.Statement {
  let cache = statements.get(db);
  if (!cache) statements.set(db, cache = new Map());
  let prepared = cache.get(sql);
  if (!prepared) cache.set(sql, prepared = db.prepare(sql));
  return prepared;
}

/** WHERE clause and bound values for one run's event filter. Field names are validated; values are always bound. */
function where(runId: string, filter: EventFilter): { sql: string; values: unknown[] } | undefined {
  const clauses = ['run_id=?'];
  const values: unknown[] = [runId];
  if (filter.after !== undefined) {
    if (!Number.isSafeInteger(filter.after) || filter.after < 0) throw new KodoError('EVENT_FILTER', 'after must be a nonnegative safe integer');
    clauses.push('seq>?'); values.push(filter.after);
  }
  if (filter.types) {
    if (!filter.types.length) return undefined;
    clauses.push(`type IN (${placeholders(filter.types)})`); values.push(...filter.types);
  }
  if (filter.typePrefix !== undefined) {
    if (!filter.typePrefix) throw new KodoError('EVENT_FILTER', 'typePrefix must be nonempty');
    // substr keeps the comparison exact for any characters (LIKE would treat % and _ as wildcards).
    clauses.push('substr(type,1,?)=?'); values.push(filter.typePrefix.length, filter.typePrefix);
  }
  for (const [key, value] of Object.entries(filter.match ?? {})) {
    if (!fieldName.test(key)) throw new KodoError('EVENT_FILTER', 'event match fields must be plain top-level names');
    const field = `'$.${key}'`;
    if (typeof value === 'boolean' || value === null) clauses.push(`json_type(data,${field})='${value === null ? 'null' : String(value)}'`);
    else if (typeof value === 'string') { clauses.push(`json_type(data,${field})='text' AND json_extract(data,${field})=?`); values.push(value); }
    else if (typeof value === 'number') { clauses.push(`json_type(data,${field}) IN ('integer','real') AND json_extract(data,${field})=?`); values.push(value); }
    else throw new KodoError('EVENT_FILTER', 'event match values must be scalars');
  }
  return { sql: clauses.join(' AND '), values };
}

export function selectEvents(db: Database.Database, runId: string, filter: EventFilter, order: 'ASC' | 'DESC' = 'ASC', limit?: number): RuntimeEvent[] {
  const clause = where(runId, filter);
  if (!clause) return [];
  const rows = statement(db, `SELECT * FROM events WHERE ${clause.sql} ORDER BY seq ${order}${limit ? ' LIMIT ?' : ''}`).all(...clause.values, ...(limit ? [limit] : [])) as StoredEvent[];
  return rows.map(eventFromRow);
}

export function countEvents(db: Database.Database, runId: string, filter: EventFilter): number {
  if (filter.after === undefined && !filter.match && filter.typePrefix === undefined) {
    if (filter.types && !filter.types.length) return 0;
    return (statement(db, `SELECT coalesce(sum(count),0) AS count FROM event_counts WHERE run_id=?${filter.types ? ` AND type IN (${placeholders(filter.types)})` : ''}`).get(runId, ...(filter.types ?? [])) as { count: number }).count;
  }
  const clause = where(runId, filter);
  if (!clause) return 0;
  return (statement(db, `SELECT count(*) AS count FROM events WHERE ${clause.sql}`).get(...clause.values) as { count: number }).count;
}

export function countCalls(db: Database.Database, runId: string, filter: CallCountFilter): number {
  if (filter.requestRef !== undefined) {
    const clause = callWhere(runId, filter);
    return clause ? (statement(db, `SELECT count(*) AS count FROM calls WHERE ${clause.sql}`).get(...clause.values) as { count: number }).count : 0;
  }
  const clauses = ['run_id=?'];
  const values: unknown[] = [runId];
  for (const column of callColumns) {
    const wanted = filter[column];
    if (wanted === undefined) continue;
    const list = typeof wanted === 'string' ? [wanted] : wanted;
    if (!list.length) return 0;
    clauses.push(`${column} IN (${placeholders(list)})`); values.push(...list);
  }
  return (statement(db, `SELECT coalesce(sum(count),0) AS count FROM call_counts WHERE ${clauses.join(' AND ')}`).get(...values) as { count: number }).count;
}

function callWhere(runId: string, filter: CallCountFilter): { sql: string; values: unknown[] } | undefined {
  const clauses = ['run_id=?'];
  const values: unknown[] = [runId];
  for (const column of callColumns) {
    const wanted = filter[column];
    if (wanted === undefined) continue;
    const list = typeof wanted === 'string' ? [wanted] : wanted;
    if (!list.length) return;
    clauses.push(`json_extract(data,'$.${column}') IN (${placeholders(list)})`);
    values.push(...list);
  }
  if (filter.requestRef !== undefined) { clauses.push("json_extract(data,'$.requestRef')=?"); values.push(filter.requestRef); }
  return { sql: clauses.join(' AND '), values };
}

/** Bounded status-prioritized reads. Each priority uses the status/step index instead of sorting the whole run. */
export function queryCalls(db: Database.Database, runId: string, filter: CallQueryFilter = {}): Call[] {
  const limit = filter.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new KodoError('CALL_FILTER', 'call limit must be between 1 and 1000');
  if (filter.statusOrder?.length) {
    const statuses = typeof filter.status === 'string' ? [filter.status] : filter.status;
    const ordered = [...new Set([...filter.statusOrder, ...(statuses ?? [])])].filter(status => !statuses || statuses.includes(status));
    const result: Call[] = [];
    for (const status of ordered) {
      result.push(...queryCalls(db, runId, { ...filter, status, statusOrder: undefined, limit: limit - result.length }));
      if (result.length === limit) break;
    }
    return result;
  }
  const clause = callWhere(runId, filter);
  if (!clause) return [];
  const rows = statement(db, `SELECT data FROM calls WHERE ${clause.sql} ORDER BY json_extract(data,'$.step') DESC,rowid DESC LIMIT ?`).all(...clause.values, limit) as { data: string }[];
  return rows.map(row => JSON.parse(row.data) as Call);
}

/** Latest event seq of a run from the materialized counters, 0 when it has none. */
export function latestEventSeq(db: Database.Database, runId: string): number {
  return (statement(db, 'SELECT coalesce(max(last_seq),0) AS seq FROM event_counts WHERE run_id=?').get(runId) as { seq: number }).seq;
}
