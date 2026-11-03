import { randomBytes } from 'node:crypto';
import type { Application } from '../application/index.js';
import type { Run, RunStatus } from '../runtime/types.js';

export type RecoveryKind = 'resume' | 'verify_write' | 'queued' | 'command_failed';

export interface RecoveryItemView {
  runId: string;
  sessionId: string;
  parentId?: string;
  role: 'main' | 'child';
  objective: string;
  status: RunStatus;
  kind: RecoveryKind;
  error: string | null;
  createdAt: string;
  lastEventAt: string;
}

export interface RecoveryView {
  serverId: string;
  startedAt: string;
  generatedAt: string;
  counts: Record<RecoveryKind, number>;
  items: RecoveryItemView[];
}

/** The serving process identity is supplied by the HTTP adapter; see createServerIdentity. */
export interface ServerIdentity {
  serverId: string;
  startedAt: string;
}

export interface RecoveryViewOptions {
  limit?: number;
  /** Identity of the local server process, so the recovery view and /api/state agree. */
  serverId?: string;
  startedAt?: string;
}

const KIND_ORDER: Record<RecoveryKind, number> = { verify_write: 0, resume: 1, command_failed: 2, queued: 3 };
const DEFAULT_LIMIT = 100;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;
/** Fallback for direct (non-HTTP) callers; the HTTP adapter always passes its own identity. */
const FALLBACK_IDENTITY: ServerIdentity = { serverId: randomBytes(16).toString('hex'), startedAt: new Date().toISOString() };

/** One identity per local server process; callers that restart must create a new value. */
export function createServerIdentity(): ServerIdentity {
  return { serverId: randomBytes(16).toString('hex'), startedAt: new Date().toISOString() };
}

/**
 * Read-only reconnect/recovery projection. Each run contributes at most one item, chosen by
 * the contract's kind priority; only sessions the server can access are included.
 */
export function recoveryView(app: Application, allowedSession: (sessionId: string) => boolean, options: RecoveryViewOptions = {}): RecoveryView {
  const limit = clampLimit(options.limit);
  const counts: Record<RecoveryKind, number> = { resume: 0, verify_write: 0, queued: 0, command_failed: 0 };
  const items: RecoveryItemView[] = [];
  // Only the newest persisted event time/type matters; reading it per run avoids loading full histories.
  for (const run of app.store.listRuns()) {
    if (!allowedSession(run.sessionId)) continue;
    const last = app.store.latestEvent(run.id);
    const kind = recoveryKind(run, last);
    if (!kind) continue;
    counts[kind] += 1;
    items.push(itemView(run, kind, last?.time ?? run.createdAt));
  }
  items.sort(compareItems);
  return {
    serverId: options.serverId ?? FALLBACK_IDENTITY.serverId,
    startedAt: options.startedAt ?? FALLBACK_IDENTITY.startedAt,
    generatedAt: new Date().toISOString(),
    counts,
    items: items.slice(0, limit),
  };
}

/** Priority: uncertain write (never auto-resumed) → interrupted → last Web command failed → accepted/queued. */
function recoveryKind(run: Run, last: { type: string } | undefined): RecoveryKind | null {
  if (run.status === 'failed' && run.error?.startsWith('UNKNOWN_WRITE')) return 'verify_write';
  if (run.status === 'interrupted') return 'resume';
  if (last?.type === 'web.command_failed') return 'command_failed';
  if (run.status === 'queued') return 'queued';
  return null;
}

function itemView(run: Run, kind: RecoveryKind, lastEventAt: string): RecoveryItemView {
  return {
    runId: run.id,
    sessionId: run.sessionId,
    ...(run.parentId === undefined ? {} : { parentId: run.parentId }),
    role: run.parentId === undefined ? 'main' : 'child',
    objective: redact(run.objective, run),
    status: run.status,
    kind,
    error: run.error === undefined ? null : redact(run.error, run),
    createdAt: run.createdAt,
    lastEventAt,
  };
}

/** Priority first, then newest event, then run ID so repeated reads are deterministic. */
function compareItems(left: RecoveryItemView, right: RecoveryItemView): number {
  const kind = KIND_ORDER[left.kind] - KIND_ORDER[right.kind];
  if (kind !== 0) return kind;
  if (left.lastEventAt !== right.lastEventAt) return left.lastEventAt < right.lastEventAt ? 1 : -1;
  return left.runId < right.runId ? -1 : left.runId > right.runId ? 1 : 0;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.trunc(limit)));
}

/** Replace the run binding's API key environment value, if present; bindings never leave this module. */
function redact(value: string, run: Run): string {
  const name = run.binding.apiKeyEnv;
  if (!name) return value;
  const secret = process.env[name];
  return secret ? value.replaceAll(secret, '[REDACTED]') : value;
}
