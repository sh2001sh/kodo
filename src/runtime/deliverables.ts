import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { KodoError } from './types.js';
import type { Deliverable } from './types.js';

/** Upper bounds that keep the per-step workspace check cheap and deterministic. */
const maxDeliverables = 16;
const maxScannedEntries = 5_000;
const skippedDirectories = new Set(['.git', '.kodo', 'node_modules']);

export interface DeliverableStatus {
  /** Human-readable label: the path or the pattern. */
  label: string;
  status: 'satisfied' | 'missing' | 'empty' | 'unchanged';
  /** Bytes of the matched file (largest match for patterns); 0 when missing. */
  bytes: number;
  minBytes: number;
  /** Matched workspace-relative files, at most five. */
  matches: string[];
}

const posix = (value: string): string => value.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/{2,}/g, '/');
const fold = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;

function relativeOk(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !path.isAbsolute(value) && !/^[a-zA-Z]:/.test(value) && !posix(value).split('/').includes('..') && !value.includes('\0');
}

/** Normalizes a legacy string entry; a trailing slash marks a directory prefix. */
export function deliverablePath(value: string): string {
  return fold(posix(value));
}

/**
 * Validates host-declared deliverables: at most 16 distinct entries, each a
 * relative path string (legacy, trailing `/` = any file below), `{ path }` or
 * `{ pattern, exclude? }`, with optional `minBytes` and `changed` (the file must
 * be modified after the run was created).
 */
export function validateDeliverables(values: unknown): Deliverable[] {
  const fail = (message: string): never => { throw new KodoError('DELIVERY_CONTRACT', message); };
  if (!Array.isArray(values) || values.length > maxDeliverables) fail(`deliverables must be an array of at most ${maxDeliverables} entries`);
  const keys = new Set<string>();
  for (const value of values as unknown[]) {
    if (typeof value === 'string') {
      if (!relativeOk(value)) fail('each deliverable must be a nonempty relative workspace path without ..');
      keys.add(deliverablePath(value));
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('each deliverable must be a path string or an object');
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).some(key => !['path', 'pattern', 'exclude', 'minBytes', 'changed'].includes(key))) fail('deliverable objects allow path, pattern, exclude, minBytes and changed');
    if ((entry.path === undefined) === (entry.pattern === undefined)) fail('a deliverable object needs exactly one of path or pattern');
    if (!relativeOk(entry.path ?? entry.pattern)) fail('deliverable path or pattern must be relative to the workspace without ..');
    if (entry.exclude !== undefined && (entry.pattern === undefined || !Array.isArray(entry.exclude) || entry.exclude.length > 16 || !entry.exclude.every(relativeOk))) fail('exclude requires a pattern and at most 16 relative globs');
    if (entry.minBytes !== undefined && (!Number.isSafeInteger(entry.minBytes) || (entry.minBytes as number) < 0 || (entry.minBytes as number) > 16 * 1024 ** 2)) fail('minBytes must be an integer from 0 to 16 MiB');
    if (entry.changed !== undefined && typeof entry.changed !== 'boolean') fail('changed must be a boolean');
    keys.add(`${entry.path === undefined ? 'pattern' : 'path'}:${deliverablePath((entry.path ?? entry.pattern) as string)}`);
  }
  if (keys.size !== (values as unknown[]).length) fail('deliverables must be distinct');
  return structuredClone(values as Deliverable[]);
}

function fileStat(file: string): { bytes: number; mtimeMs: number } | undefined {
  try {
    const stat = statSync(file);
    return stat.isFile() ? { bytes: stat.size, mtimeMs: stat.mtimeMs } : undefined;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}

/** Files below `start`, workspace-relative with forward slashes, bounded and skipping dependency/runtime directories. */
function walk(workspace: string, start: string): string[] {
  const files: string[] = [];
  const queue = [start];
  let scanned = 0;
  while (queue.length && scanned < maxScannedEntries) {
    const directory = queue.shift()!;
    let entries;
    try { entries = readdirSync(path.join(workspace, directory), { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (++scanned > maxScannedEntries) break;
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!skippedDirectories.has(entry.name)) queue.push(relative); }
      else if (entry.isFile()) files.push(relative);
    }
  }
  return files;
}

/** Literal directory prefix of a glob, used to bound the walk. */
function globRoot(pattern: string): string {
  const parts = posix(pattern).split('/');
  const literal: string[] = [];
  for (const part of parts.slice(0, -1)) {
    if (/[*?[\]{}!]/.test(part)) break;
    literal.push(part);
  }
  return literal.join('/');
}

function matches(file: string, pattern: string): boolean {
  return path.posix.matchesGlob(fold(file), fold(posix(pattern)));
}

/**
 * Checks each deliverable against the actual workspace files. A file counts when
 * it exists, has at least `minBytes` bytes (default 1) and, with `changed`, was
 * modified after `sinceMs`. Pattern entries pass when any non-excluded match passes.
 */
export function deliverableStatus(workspace: string, deliverables: readonly Deliverable[] | undefined, sinceMs: number): DeliverableStatus[] {
  if (!deliverables?.length) return [];
  return deliverables.map(entry => {
    const spec = typeof entry === 'string' ? { path: entry } : entry;
    const minBytes = spec.minBytes ?? 1;
    const changed = spec.changed === true;
    let candidates: string[];
    let label: string;
    if (spec.pattern !== undefined) {
      label = spec.pattern;
      candidates = walk(workspace, globRoot(spec.pattern)).filter(file => matches(file, spec.pattern!) && !(spec.exclude ?? []).some(glob => matches(file, glob)));
    } else if (posix(spec.path!).endsWith('/')) {
      label = spec.path!;
      candidates = walk(workspace, posix(spec.path!).replace(/\/$/, ''));
    } else {
      label = spec.path!;
      candidates = [posix(spec.path!)];
    }
    const found = candidates.map(file => ({ file, stat: fileStat(path.join(workspace, file)) })).filter(item => item.stat !== undefined) as { file: string; stat: { bytes: number; mtimeMs: number } }[];
    const fresh = changed ? found.filter(item => item.stat.mtimeMs > sinceMs) : found;
    const passing = fresh.filter(item => item.stat.bytes >= minBytes);
    const best = (passing.length ? passing : fresh.length ? fresh : found).toSorted((left, right) => right.stat.bytes - left.stat.bytes);
    const status: DeliverableStatus['status'] = passing.length ? 'satisfied' : fresh.length ? 'empty' : found.length ? 'unchanged' : 'missing';
    return { label, status, bytes: best[0]?.stat.bytes ?? 0, minBytes, matches: best.slice(0, 5).map(item => item.file) };
  });
}

/** One line per unsatisfied deliverable, phrased for a model-facing notice. */
export function describeUnsatisfied(statuses: readonly DeliverableStatus[]): string[] {
  return statuses.filter(item => item.status !== 'satisfied').map(item => {
    if (item.status === 'missing') return `${item.label}: missing`;
    if (item.status === 'unchanged') return `${item.label}: exists but was not created or changed during this task (${item.matches.join(', ')})`;
    return `${item.label}: too small (${item.bytes} bytes; needs at least ${item.minBytes})`;
  });
}
