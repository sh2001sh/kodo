import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { KodoError } from '../runtime/types.js';

export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Arrays of objects at least this large are stored as one segment per element. */
const segmentThreshold = 4096;
const segmentsKey = 'kodo.segments';
const sequenceKey = 'kodo.sequence';
const manifestKey = 'kodo.blob';
const fileMarker = JSON.stringify({ [manifestKey]: 'file' });
const sequenceChunk = 32;
/** Verified text kept in memory; content addressing makes it immutable. */
const cacheChars = 32 * 1024 * 1024;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isObject = (value: Json): value is { [key: string]: Json } => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Content-addressed JSON blobs. A ref is always the SHA-256 of the full
 * `JSON.stringify` text. Large arrays of objects are stored as one segment per
 * element plus immutable reference chunks and sparse overlays, so a context
 * that grows by a few messages stores only new messages and a bounded delta.
 *
 * Small values/metadata live in SQLite; large values are flushed as a file batch
 * before their rows commit. A rolled-back transaction publishes neither the
 * manifest nor its parts; unreferenced file payloads are reclaimed by GC.
 * Stored text that hashes to its ref is ordinary content; anything else must be a
 * manifest whose reconstruction hashes to the ref.
 */
export class BlobStore {
  private readonly root: string;
  private readonly known = new Set<string>();
  private readonly cache = new Map<string, string>();
  private cached = 0;
  private readonly sequences = new Map<string, { ref: string; items: string[] }>();
  private readonly selectRow: Database.Statement<[string], { data: string }>;
  private readonly insertRow: Database.Statement<[string, string]>;

  constructor(directory: string, private readonly db: Database.Database) {
    this.root = path.join(directory, 'blobs');
    this.selectRow = db.prepare('SELECT data FROM blob_segments WHERE ref=?');
    this.insertRow = db.prepare('INSERT OR IGNORE INTO blob_segments(ref,data) VALUES (?,?)');
  }

  write(value: unknown): string {
    const content = JSON.stringify(value);
    const ref = digest(content);
    if (this.exists(ref)) return ref;
    const rows = new Map<string, string>();
    const stored = this.layout(content, JSON.parse(content) as Json, rows);
    rows.set(ref, stored);
    this.insert(rows);
    return ref;
  }

  /** Whether a stored form (segment row or file) exists for `ref`; content is not verified. */
  has(ref: string): boolean {
    return /^[a-f0-9]{64}$/.test(ref) && (Boolean(this.selectRow.get(ref)) || existsSync(this.file(ref)));
  }

  read<T>(ref: string): T {
    return JSON.parse(this.text(ref)) as T;
  }

  /** Stored text without reconstruction; garbage collection marks references from it. */
  raw(ref: string): string | undefined {
    const row = this.selectRow.get(ref);
    if (row) return row.data === fileMarker && digest(row.data) !== ref ? readFileSync(this.payloadFile(ref), 'utf8') : row.data;
    const file = this.file(ref);
    return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  }

  /** Removes every stored blob whose ref is not marked, then drops existence and content knowledge. */
  sweep(marked: Set<string>): { removed: number; freedBytes: number } {
    const removed = new Set<string>();
    let freedBytes = 0;
    for (const file of readdirSync(this.root)) if (/^[a-f0-9]{64}\.(?:json|blob)$/.test(file) && !marked.has(file.slice(0, 64))) {
      const target = path.join(this.root, file);
      freedBytes += statSync(target).size;
      unlinkSync(target);
      removed.add(file.slice(0, 64));
    }
    const rows = this.db.prepare('SELECT ref, length(CAST(data AS BLOB)) AS size FROM blob_segments').all() as { ref: string; size: number }[];
    const remove = this.db.prepare('DELETE FROM blob_segments WHERE ref=?');
    this.db.transaction(() => {
      for (const row of rows) if (!marked.has(row.ref)) {
        remove.run(row.ref);
        freedBytes += row.size;
        removed.add(row.ref);
      }
    })();
    this.known.clear();
    this.cache.clear();
    this.cached = 0;
    this.sequences.clear();
    return { removed: removed.size, freedBytes };
  }
  /** Stored form of `content`: the text itself, or a manifest whose new segments are added to `rows`. */
  private layout(content: string, parsed: Json, rows: Map<string, string>): string {
    let segmented = false;
    let reserved = false;
    const template = (node: Json): Json => {
      if (Array.isArray(node)) {
        if (node.length > 1 && node.every(isObject)) {
          // Each element is serialized once; the text serves both the threshold and its digest.
          const texts = node.map(element => JSON.stringify(element));
          if (texts.reduce((sum, text) => sum + text.length + 1, 1) >= segmentThreshold) {
            segmented = true;
            return { [sequenceKey]: this.sequence(node.map((element, index) => this.segment(texts[index]!, element, rows)), rows) };
          }
        }
        return node.map(template);
      }
      if (!isObject(node)) return node;
      // Content that could be read as a template marker is stored verbatim.
      if (segmentsKey in node || sequenceKey in node || manifestKey in node) reserved = true;
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, template(child)]));
    };
    const shape = template(parsed);
    return segmented && !reserved ? JSON.stringify({ [manifestKey]: 'manifest', value: shape }) : content;
  }

  private segment(text: string, element: Json, rows: Map<string, string>): string {
    const ref = digest(text);
    if (!rows.has(ref) && !this.exists(ref)) rows.set(ref, this.layout(text, element, rows));
    return ref;
  }

  /** Immutable append chunks plus sparse replacement/truncation overlays. A growing history never rewrites its full reference list. */
  private sequence(items: string[], rows: Map<string, string>): string {
    const put = (value: Record<string, Json>): string => {
      const text = JSON.stringify(value);
      const ref = digest(text);
      if (!rows.has(ref) && !this.exists(ref)) rows.set(ref, text);
      return ref;
    };
    const key = items[0]!;
    const previous = this.sequences.get(key);
    let result: string | undefined;
    if (previous && (rows.has(previous.ref) || this.has(previous.ref))) {
      const changes: Json[] = [];
      for (let index = 0; index < items.length; index++) if (items[index] !== previous.items[index]) changes.push([index, items[index]!]);
      if (!changes.length && items.length === previous.items.length) return previous.ref;
      // Sparse overlays record only changed/appended references and the new length.
      if (changes.length <= sequenceChunk) result = put({ [manifestKey]: 'overlay', base: previous.ref, length: items.length, changes });
    }
    if (!result) {
      let tail: string | null = null;
      for (let offset = 0; offset < items.length; offset += sequenceChunk) {
        const chunk = items.slice(offset, offset + sequenceChunk);
        tail = put({ [manifestKey]: 'sequence', previous: tail, items: chunk, length: offset + chunk.length });
      }
      result = tail!;
    }
    this.sequences.delete(key);
    this.sequences.set(key, { ref: result, items });
    // This is an optimization only; reopening or evicting falls back to shared immutable chunks.
    while (this.sequences.size > 32) this.sequences.delete(this.sequences.keys().next().value!);
    return result;
  }

  private sequenceItems(ref: string): string[] {
    const pending: { length: number; changes: [number, string][] }[] = [];
    const chunks: string[][] = [];
    const seen = new Set<string>();
    let current: string | null = ref;
    while (current) {
      if (seen.has(current)) throw new KodoError('BLOB_CORRUPT', 'cyclic sequence reference');
      seen.add(current);
      const raw = this.raw(current);
      if (raw === undefined || digest(raw) !== current) throw new KodoError('BLOB_CORRUPT', 'stored sequence digest mismatch');
      const node = JSON.parse(raw) as Record<string, unknown>;
      if (!Number.isSafeInteger(node.length) || Number(node.length) < 0) throw new KodoError('BLOB_CORRUPT', 'invalid sequence length');
      if (node[manifestKey] === 'overlay' && typeof node.base === 'string' && Array.isArray(node.changes)) {
        if (chunks.length) throw new KodoError('BLOB_CORRUPT', 'invalid sequence chain');
        const changes = node.changes as [number, string][];
        if (changes.some(change => !Array.isArray(change) || change.length !== 2 || !Number.isSafeInteger(change[0]) || change[0] < 0 || change[0] >= Number(node.length) || typeof change[1] !== 'string')) throw new KodoError('BLOB_CORRUPT', 'invalid sequence overlay');
        pending.push({ length: Number(node.length), changes });
        current = node.base;
      } else if (node[manifestKey] === 'sequence' && Array.isArray(node.items) && node.items.every(item => typeof item === 'string') && (node.previous === null || typeof node.previous === 'string')) {
        chunks.push(node.items as string[]);
        current = node.previous as string | null;
      } else throw new KodoError('BLOB_CORRUPT', 'invalid sequence node');
    }
    const items = chunks.reverse().flat();
    for (const overlay of pending.reverse()) {
      items.length = overlay.length;
      for (const [index, value] of overlay.changes) items[index] = value;
    }
    if (Array.from(items).some(item => typeof item !== 'string')) throw new KodoError('BLOB_CORRUPT', 'incomplete sequence overlay');
    if (items.length) {
      this.sequences.delete(items[0]!);
      this.sequences.set(items[0]!, { ref, items });
      while (this.sequences.size > 32) this.sequences.delete(this.sequences.keys().next().value!);
    }
    return items;
  }

  private insert(rows: Map<string, string>): void {
    const files: { ref: string; fd: number; temp: string }[] = [];
    try {
      for (const [ref, data] of rows) if (Buffer.byteLength(data) >= segmentThreshold && !existsSync(this.payloadFile(ref))) {
        const temp = `${this.payloadFile(ref)}.${randomUUID()}.tmp`;
        const fd = openSync(temp, 'wx', 0o600);
        files.push({ ref, fd, temp });
        writeFileSync(fd, data, 'utf8');
      }
      // Flush the prepared batch before publishing any row that refers to it.
      for (const file of files) fsyncSync(file.fd);
      for (const file of files) { closeSync(file.fd); file.fd = -1; renameSync(file.temp, this.payloadFile(file.ref)); }
      if (files.length && process.platform !== 'win32') {
        const directory = openSync(this.root, 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      this.db.transaction(() => { for (const [ref, data] of rows) this.insertRow.run(ref, Buffer.byteLength(data) < segmentThreshold ? data : fileMarker); })();
    } finally {
      for (const file of files) {
        if (file.fd !== -1) closeSync(file.fd);
        if (existsSync(file.temp)) unlinkSync(file.temp);
      }
    }
    if (!this.db.inTransaction) for (const ref of rows.keys()) this.known.add(ref);
  }

  /** Verified full JSON text of a blob. */
  private text(ref: string): string {
    if (!/^[a-f0-9]{64}$/.test(ref)) throw new KodoError('BLOB_REF', 'invalid content reference');
    const hit = this.cache.get(ref);
    if (hit !== undefined) {
      this.cache.delete(ref);
      this.cache.set(ref, hit);
      return hit;
    }
    const stored = this.raw(ref);
    if (stored === undefined) throw new KodoError('BLOB_REF', 'stored content reference is missing');
    const content = digest(stored) === ref ? stored : this.reconstruct(stored);
    if (digest(content) !== ref) throw new KodoError('BLOB_CORRUPT', 'stored content digest mismatch');
    if (!this.db.inTransaction) this.remember(ref, content);
    return content;
  }

  private reconstruct(stored: string): string {
    let manifest: unknown;
    try { manifest = JSON.parse(stored); } catch { throw new KodoError('BLOB_CORRUPT', 'stored content digest mismatch'); }
    if (!isObject(manifest as Json) || (manifest as Record<string, Json>)[manifestKey] !== 'manifest') throw new KodoError('BLOB_CORRUPT', 'stored content digest mismatch');
    const resolve = (node: Json): Json => {
      if (Array.isArray(node)) return node.map(resolve);
      if (!isObject(node)) return node;
      const refs = node[segmentsKey];
      if (Object.keys(node).length === 1 && Array.isArray(refs) && refs.every(item => typeof item === 'string')) return refs.map(item => JSON.parse(this.text(item as string)) as Json);
      const sequence = node[sequenceKey];
      if (Object.keys(node).length === 1 && typeof sequence === 'string') return this.sequenceItems(sequence).map(item => JSON.parse(this.text(item)) as Json);
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, resolve(child)]));
    };
    return JSON.stringify(resolve((manifest as Record<string, Json>).value ?? null));
  }

  private exists(ref: string): boolean {
    if (this.known.has(ref)) return true;
    if (!this.has(ref)) return false;
    if (!this.db.inTransaction) this.known.add(ref);
    return true;
  }

  private remember(ref: string, content: string): void {
    if (content.length > cacheChars / 4) return;
    this.cache.set(ref, content);
    this.cached += content.length;
    for (const [key, value] of this.cache) {
      if (this.cached <= cacheChars) break;
      this.cache.delete(key);
      this.cached -= value.length;
    }
  }

  private file(ref: string): string { return path.join(this.root, `${ref}.json`); }
  private payloadFile(ref: string): string { return path.join(this.root, `${ref}.blob`); }
}
