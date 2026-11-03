import type { Application } from '../application/index.js';
import type { Envelope, Run, RuntimeEvent, Wait } from '../runtime/types.js';
import { terminal } from '../runtime/types.js';
import { childCapacity } from '../messaging/spawn-spec.js';

export interface AgentResultView {
  available: boolean;
  summary: string;
  truncated: boolean;
  quality: 'passed' | 'not_checked' | 'failed' | 'unknown';
  stale: boolean;
  resultRef: string | null;
}

export interface AgentBlockedView {
  reason: 'user_question' | 'peer' | 'timeout' | 'validation' | null;
  questionIds: string[];
  runIds: string[];
  until: number | null;
}

export interface AgentView {
  id: string;
  agentId?: string;
  parentId?: string;
  role: 'main' | 'child';
  objective: string;
  status: Run['status'];
  state: 'queued' | 'running' | 'waiting_user' | 'waiting_peer' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  requiresValidation: boolean;
  stale: boolean;
  decisionVersion: number;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  blocked: AgentBlockedView | null;
  result: AgentResultView | null;
}

export type PendingKind =
  | 'question' | 'failed' | 'unknown_write' | 'interrupted'
  | 'unverified_result' | 'command_failed' | 'blocked' | 'agent_proposal';

export type PendingAction = 'answer' | 'resume' | 'cancel' | 'view_agent' | 'inspect' | 'retain' | 'discard' | 'edit' | 'skip';

export interface PendingView {
  id: string;
  kind: PendingKind;
  severity: 'critical' | 'warning' | 'info';
  runId: string;
  role: 'main' | 'child';
  agentObjective: string;
  title: string;
  detail: string;
  questionId?: string;
  createdAt: string;
  order: number;
  actions: PendingAction[];
  proposal?: ReturnType<Application['retention']['list']>[number];
}

export interface CollaborationView {
  sessionId: string;
  anchorRunId: string;
  decisionVersion: number;
  children: { maximum: number | null; maximumActive: number | null; created: number; active: number; remainingActive: number | null };
  agents: AgentView[];
  pending: PendingView[];
  drafts: ReturnType<Application['retention']['list']>;
  generatedAt: string;
}

const SUMMARY_LIMIT = 600;
const DETAIL_LIMIT = 160;
const SEVERITY_ORDER: Record<PendingView['severity'], number> = { critical: 0, warning: 1, info: 2 };

type AgentRole = 'main' | 'child';
interface AgentEntry { run: Run; role: AgentRole }

interface Projection {
  app: Application;
  sessionId: string;
  decisionVersion: number;
  events: Map<string, RuntimeEvent[]>;
  waits: Map<string, Wait | null>;
}

/** Read-only panel projection: never mutates storage, never issues model calls. */
export function collaborationView(app: Application, runId: string): CollaborationView {
  const requested = app.store.run(runId);
  // A child run is presented through the main task that owns it; other roots stay out of this panel.
  const anchor = requested.parentId ? app.store.run(requested.parentId) : requested;
  const session = app.store.session(anchor.sessionId);
  const decisionVersion = session.decisionVersion ?? 0;
  const projection: Projection = { app, sessionId: anchor.sessionId, decisionVersion, events: new Map(), waits: new Map() };
  const sessionRuns = app.store.listRuns(anchor.sessionId);
  const childRuns = sessionRuns.filter(run => run.parentId === anchor.id);
  // Admission is session-wide; the view uses the same occupancy as child creation.
  const capacity = childCapacity(app.store, anchor.sessionId);
  const entries: AgentEntry[] = [{ run: anchor, role: 'main' }, ...childRuns.map((run): AgentEntry => ({ run, role: 'child' }))];
  const drafts = app.retention.list(anchor.sessionId).filter(draft => ['draft', 'requested', 'editing'].includes(draft.status));
  const proposals: PendingView[] = terminal(anchor.status) ? drafts.filter(draft => !draft.silent).map(draft => ({
    id: `agent-proposal:${draft.id}`, kind: 'agent_proposal', severity: 'info', runId: draft.sourceRun,
    role: 'child', agentObjective: draft.name, title: draft.name,
    detail: '核对来源、方法与验收记录后保留；将在下一次会话中可用。', createdAt: draft.createdAt,
    order: Number.MAX_SAFE_INTEGER, actions: ['retain', 'discard', 'edit', 'skip', 'view_agent'], proposal: draft,
  })) : [];
  return {
    sessionId: anchor.sessionId,
    anchorRunId: anchor.id,
    decisionVersion,
    children: {
      maximum: capacity.maximum,
      maximumActive: capacity.maximumActive,
      created: capacity.created,
      active: capacity.active,
      remainingActive: capacity.remainingActive,
    },
    agents: entries.map(entry => agentView(projection, entry)),
    pending: [...collectPending(projection, entries), ...proposals],
    drafts,
    generatedAt: new Date().toISOString(),
  };
}

function agentView(projection: Projection, entry: AgentEntry): AgentView {
  const { run, role } = entry;
  const last = lastEvent(projection, run);
  const wait = registeredWait(projection, run);
  return {
    id: run.id,
    ...(run.agentId === undefined ? {} : { agentId: run.agentId }),
    ...(run.parentId === undefined ? {} : { parentId: run.parentId }),
    role,
    objective: redact(run.objective, run),
    status: run.status,
    state: agentState(projection, run, wait),
    requiresValidation: run.requiresValidation === true,
    stale: isStale(projection, run),
    decisionVersion: run.decisionVersion ?? 0,
    createdAt: run.createdAt,
    updatedAt: last ? last.time : run.createdAt,
    error: run.error === undefined ? null : redact(run.error, run),
    blocked: blockedView(projection, run, wait),
    result: resultView(projection, run),
  };
}

/** Durable run state is authoritative; a waiting run additionally derives its blocker from the registered wait. */
function agentState(projection: Projection, run: Run, wait: Wait | null): AgentView['state'] {
  if (run.status !== 'waiting') return run.status;
  if (!wait) return 'waiting';
  const dependencies = waitDependencies(projection, wait);
  if (dependencies.questionIds.length) return 'waiting_user';
  if (dependencies.peerRunIds.length) return 'waiting_peer';
  return 'waiting';
}

function blockedView(projection: Projection, run: Run, wait: Wait | null): AgentBlockedView | null {
  // Uncertain writes always need host verification, independent of any registered wait.
  if (run.status === 'failed' && run.error !== undefined && run.error.startsWith('UNKNOWN_WRITE')) {
    return { reason: 'validation', questionIds: [], runIds: [], until: null };
  }
  if (!wait) return null;
  const dependencies = waitDependencies(projection, wait);
  const reason: AgentBlockedView['reason'] = dependencies.questionIds.length
    ? 'user_question'
    : dependencies.peerRunIds.length
      ? 'peer'
      : Date.now() >= wait.deadline
        ? 'timeout'
        : null;
  return { reason, questionIds: dependencies.questionIds, runIds: dependencies.peerRunIds, until: wait.deadline };
}

function waitDependencies(projection: Projection, wait: Wait): { questionIds: string[]; peerRunIds: string[] } {
  const questionIds: string[] = [];
  const peerRunIds = new Set<string>();
  for (const id of wait.questionIds) {
    const question = findMessage(projection, id);
    if (!question || question.kind !== 'question' || projection.app.store.answer(id)) continue;
    if (question.to === 'user') { questionIds.push(id); continue; }
    const peer = findRun(projection, question.to);
    if (peer && !terminal(peer.status)) peerRunIds.add(peer.id);
  }
  for (const id of wait.runIds) {
    const peer = findRun(projection, id);
    if (peer && !terminal(peer.status)) peerRunIds.add(peer.id);
  }
  return { questionIds, peerRunIds: [...peerRunIds] };
}

function registeredWait(projection: Projection, run: Run): Wait | null {
  const waitId = run.waitId;
  if (!waitId) return null;
  const cached = projection.waits.get(waitId);
  if (cached !== undefined) return cached;
  let wait: Wait | null = null;
  try {
    const stored = projection.app.store.wait(waitId);
    if (stored.status === 'registered') wait = stored;
  } catch { wait = null; }
  projection.waits.set(waitId, wait);
  return wait;
}

function resultView(projection: Projection, run: Run): AgentResultView | null {
  const resultRef = run.resultRef;
  if (!resultRef) return null;
  const stale = isStale(projection, run);
  let blob: unknown;
  try { blob = projection.app.store.readBlob<unknown>(resultRef); }
  catch { return { available: false, summary: '', truncated: false, quality: 'unknown', stale, resultRef }; }
  const record = recordOf(blob);
  if (!record) return { available: false, summary: '', truncated: false, quality: 'unknown', stale, resultRef };
  const summary = truncate(redact(summaryText(run, record), run), SUMMARY_LIMIT);
  return { available: true, summary: summary.text, truncated: summary.truncated, quality: qualityFrom(blob), stale, resultRef };
}

function qualityFrom(blob: unknown): AgentResultView['quality'] {
  const record = recordOf(blob);
  if (!record) return 'unknown';
  const quality = recordOf(record['quality']);
  const status = quality ? quality['status'] : undefined;
  if (status === 'passed') return 'passed';
  if (status === 'failed') return 'failed';
  return 'not_checked';
}

function qualityFromBlob(projection: Projection, resultRef: string): AgentResultView['quality'] {
  try { return qualityFrom(projection.app.store.readBlob<unknown>(resultRef)); }
  catch { return 'unknown'; }
}

/** Exploration results wrap their deliverable in a JSON envelope; the panel shows the summary only. */
function summaryText(run: Run, record: Record<string, unknown>): string {
  const text = typeof record['text'] === 'string' ? record['text'] : '';
  if (!run.exploration || !text) return text;
  const parsed = parseObject(text);
  const summary = parsed ? parsed['summary'] : undefined;
  return typeof summary === 'string' ? summary : text;
}

function collectPending(projection: Projection, entries: AgentEntry[]): PendingView[] {
  const byId = new Map(entries.map(entry => [entry.run.id, entry] as const));
  const collected: PendingView[] = [];
  for (const message of projection.app.store.unansweredQuestions(projection.sessionId, 'user')) {
    const entry = byId.get(message.from);
    // A question from an owner outside this panel, or from a terminal record, is not actionable here.
    if (!entry || terminal(entry.run.status)) continue;
    collected.push(questionPending(projection, message, entry));
  }
  for (const entry of entries) collected.push(...agentPending(projection, entry));
  // One stable ID per underlying event: SSE replay and repeated refreshes never append duplicates.
  const unique = new Map<string, PendingView>();
  for (const item of collected) if (!unique.has(item.id)) unique.set(item.id, item);
  return [...unique.values()].sort(comparePending);
}

function questionPending(projection: Projection, message: Envelope, entry: AgentEntry): PendingView {
  const { run, role } = entry;
  const created = eventsOf(projection, run).find(event => event.type === 'message.created' && event.data['messageId'] === message.id);
  return {
    id: `question:${message.id}`,
    kind: 'question',
    severity: 'warning',
    runId: run.id,
    role,
    agentObjective: redact(run.objective, run),
    title: '需要你回答',
    detail: truncate(redact(message.content, run), DETAIL_LIMIT).text,
    questionId: message.id,
    createdAt: created ? created.time : lastEventTime(projection, run),
    order: message.seq,
    actions: ['answer', 'view_agent'],
  };
}

function agentPending(projection: Projection, entry: AgentEntry): PendingView[] {
  const { run, role } = entry;
  const events = eventsOf(projection, run);
  const last = events.at(-1);
  const lastSeq = last ? last.seq : 0;
  const lastTime = last ? last.time : run.createdAt;
  const base = { runId: run.id, role, agentObjective: redact(run.objective, run) };
  const items: PendingView[] = [];
  if (run.status === 'failed') {
    const unknownWrite = run.error !== undefined && run.error.startsWith('UNKNOWN_WRITE');
    const kind: PendingKind = unknownWrite ? 'unknown_write' : 'failed';
    const fallback = unknownWrite ? '写入结果未知，禁止自动恢复；需由宿主核实。' : '运行以失败状态结束。';
    items.push({
      ...base,
      id: `${kind}:${run.id}`,
      kind,
      severity: 'critical',
      title: unknownWrite ? '写入结果不确定' : '执行失败',
      detail: truncate(redact(run.error ?? fallback, run), DETAIL_LIMIT).text,
      createdAt: lastTime,
      order: lastSeq,
      actions: ['view_agent', 'inspect'],
    });
  }
  if (run.status === 'interrupted') {
    items.push({
      ...base,
      id: `interrupted:${run.id}`,
      kind: 'interrupted',
      severity: 'warning',
      title: '执行中断',
      detail: truncate(redact(run.error ?? '执行在完成前中断，可在核实后恢复。', run), DETAIL_LIMIT).text,
      createdAt: lastTime,
      order: lastSeq,
      actions: role === 'main' ? ['resume', 'view_agent', 'inspect'] : ['view_agent', 'inspect'],
    });
  }
  if (run.status === 'completed' && run.resultRef) {
    const resultRef = run.resultRef;
    const quality = qualityFromBlob(projection, resultRef);
    if (quality !== 'passed') {
      const stale = isStale(projection, run);
      const summary = resultView(projection, run)?.summary ?? '';
      const prefix = stale ? '决定版本已变化，需复核。' : quality === 'failed' ? '验收失败。' : '执行已结束但尚未验收。';
      items.push({
        ...base,
        id: `unverified_result:${run.id}:${resultRef}`,
        kind: 'unverified_result',
        severity: stale ? 'warning' : 'info',
        title: '结果未验收',
        detail: truncate(prefix + summary, DETAIL_LIMIT).text,
        createdAt: lastTime,
        order: lastSeq,
        actions: ['view_agent', 'inspect'],
      });
    }
  }
  // The newest persisted event decides whether the last Web command for this run failed.
  if (last && last.type === 'web.command_failed') {
    const detail = [textData(last.data, 'action'), textData(last.data, 'code'), textData(last.data, 'message')].filter((value): value is string => value !== undefined && value.length > 0).join(' · ') || 'Web 命令执行失败。';
    items.push({
      ...base,
      id: `command_failed:${run.id}:${last.seq}`,
      kind: 'command_failed',
      severity: 'warning',
      title: '命令执行失败',
      detail: truncate(redact(detail, run), DETAIL_LIMIT).text,
      createdAt: lastTime,
      order: last.seq,
      actions: ['view_agent', 'inspect'],
    });
  }
  const deadlock = findDeadlock(events);
  // A deadlock on an already terminal record is history, not an actionable pending item.
  if (deadlock && !terminal(run.status)) {
    const runs = deadlock.data['runs'];
    const count = Array.isArray(runs) ? runs.length : 0;
    items.push({
      ...base,
      id: `blocked:${run.id}:${deadlock.seq}`,
      kind: 'blocked',
      severity: 'warning',
      title: '协作等待死锁',
      detail: truncate(`协作等待形成死锁，涉及 ${count} 个运行；需检查依赖关系后重新安排。`, DETAIL_LIMIT).text,
      createdAt: deadlock.time,
      order: deadlock.seq,
      actions: ['view_agent'],
    });
  }
  return items;
}

/** Severity first, then newest first, then ID ordering so refresh is deterministic. */
function comparePending(left: PendingView, right: PendingView): number {
  const severity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
  if (severity !== 0) return severity;
  if (left.order !== right.order) return right.order - left.order;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function findDeadlock(events: RuntimeEvent[]): RuntimeEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.type === 'wait.deadlock') return event;
  }
  return undefined;
}

function eventsOf(projection: Projection, run: Run): RuntimeEvent[] {
  const cached = projection.events.get(run.id);
  if (cached) return cached;
  const events = projection.app.store.events(run.id);
  projection.events.set(run.id, events);
  return events;
}

function lastEvent(projection: Projection, run: Run): RuntimeEvent | undefined {
  return eventsOf(projection, run).at(-1);
}

function lastEventTime(projection: Projection, run: Run): string {
  return lastEvent(projection, run)?.time ?? run.createdAt;
}

function findRun(projection: Projection, id: string): Run | null {
  try { return projection.app.store.run(id); }
  catch { return null; }
}

function findMessage(projection: Projection, id: string): Envelope | undefined {
  try { return projection.app.store.message(id); }
  catch { return undefined; }
}

function isStale(projection: Projection, run: Run): boolean {
  return (run.decisionVersion ?? 0) < projection.decisionVersion;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseObject(value: string): Record<string, unknown> | null {
  try { return recordOf(JSON.parse(value)); }
  catch { return null; }
}

function textData(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' ? value : undefined;
}

/** Replace the run binding's API key environment value, if present; binding details never leave this module. */
function secretOf(run: Run): string | undefined {
  const name = run.binding.apiKeyEnv;
  if (!name) return undefined;
  const value = process.env[name];
  return value ? value : undefined;
}

function redact(value: string, run: Run): string {
  const secret = secretOf(run);
  return secret === undefined ? value : value.replaceAll(secret, '[REDACTED]');
}

/** Truncation must not leave a lone surrogate when the cut lands inside a surrogate pair. */
function truncate(value: string, limit: number): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false };
  let end = limit;
  const last = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return { text: value.slice(0, end), truncated: true };
}
