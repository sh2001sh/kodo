import { randomUUID } from 'node:crypto';
import { Ajv } from 'ajv';
import { parseCard, serializeCard } from './card.js';
import { hostPrivateValues, safeOutput } from './authoring.js';
import { reportCompleteness } from '../runtime/report.js';
import { digest } from '../storage/index.js';
import type { Store } from '../storage/index.js';
import { KodoError } from '../runtime/types.js';
import type { Card, Run } from '../runtime/types.js';
import type { ToolRegistration } from '../tools/registry.js';

export type AgentRetentionMode = 'review' | 'off';
export interface RetentionCatalog { path: string; aliases?: string[] }
export interface RetentionRouting { use_when: string[]; not_for?: string[]; mode: 'read' | 'review' | 'write' }
export interface RetentionMetadata { name: string; catalog?: RetentionCatalog; routing?: RetentionRouting; reason?: string }
export interface RetentionEvidence {
  runStatus: Run['status'];
  reportCompleteness: { status: string };
  hostAcceptance: { status: string; evidenceRef?: string };
  mainAcceptance: { status: 'not_recorded' };
  toolsUsed: string[];
  changedFiles: number;
  changedPaths: string[];
  changedFilesComplete: boolean;
}
export interface RetentionDraft {
  id: string; draftId: string; digest: string; revision: number; sessionId: string; sourceRun: string; ownerRun: string;
  name: string; card: Card; cardContent: string; evidence: RetentionEvidence; reason?: string;
  status: 'draft' | 'requested' | 'approved' | 'rejected' | 'editing'; silent: boolean; createdAt: string; updatedAt: string;
}
export interface RetentionUserAction {
  source: 'terminal_key' | 'web_button' | 'conversation' | 'cli' | 'workbench';
  userEventId: string;
}
export interface AgentRetentionOptions {
  mode?: AgentRetentionMode;
  ownerId?: string;
  /** Host registration validation, also applied before a proposal becomes visible. */
  validateCard?: (card: Card) => void;
  /** Host-only registration, invoked in the approval transaction after digest validation. */
  registerCard?: (card: Card) => void;
}
const strings = { type: 'array', minItems: 1, maxItems: 32, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 1000 } };
const catalogSchema = { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*(/[a-z0-9][a-z0-9-]*){1,3}$', maxLength: 200 }, aliases: { ...strings, minItems: 0 } } };
const routingSchema = { type: 'object', additionalProperties: false, required: ['use_when', 'mode'], properties: { use_when: strings, not_for: { ...strings, minItems: 0 }, mode: { enum: ['read', 'review', 'write'] } } };
const metadataProperties = { name: { type: 'string', minLength: 1, maxLength: 200 }, catalog: catalogSchema, routing: routingSchema, reason: { type: 'string', maxLength: 2000 } };
const validateMetadata = new Ajv({ allErrors: true }).compile({ type: 'object', additionalProperties: false, required: ['name'], properties: metadataProperties });
const fail = (code: string, message: string): KodoError => new KodoError(`AGENT_RETENTION_${code}`, message);

function metadata(input: unknown): RetentionMetadata {
  if (!validateMetadata(input)) throw fail('INPUT', 'provide name and valid catalog/routing metadata only');
  const value = input as RetentionMetadata;
  if (!value.name.trim() || value.routing?.use_when.some(text => !text.trim())) throw fail('INPUT', 'name and routing examples must not be blank');
  return structuredClone(value);
}

/** Evidence is copied from kernel records, never from the model's reason text. */
function sourceEvidence(store: Store, source: Run): RetentionEvidence {
  const calls = store.calls(source.id).filter(call => call.kind === 'tool' && call.status !== 'planned');
  const toolsUsed = [...new Set(calls.map(call => call.name))].sort();
  const changedPaths = new Set<string>();
  const observedCalls = new Set<string>();
  for (const event of store.events(source.id, { types: ['file.recovery.completed'] })) {
    if (typeof event.data.callId === 'string') observedCalls.add(event.data.callId);
    const prepared = store.latestEvent(source.id, { types: ['file.recovery.prepared'], match: { id: event.data.preparationId as string } });
    if (!prepared) continue;
    const requestRef = prepared.data.requestRef;
    if (typeof requestRef !== 'string') continue;
    const request = store.readBlob<{ arguments: string }>(requestRef);
    const args = JSON.parse(request.arguments) as { path?: string; destination?: string };
    for (const value of [args.path, args.destination]) if (typeof value === 'string') changedPaths.add(value);
  }
  let changedFilesComplete = true;
  for (const call of calls.filter(call => call.effect === 'write' && call.effectState !== 'not_started' && call.name !== 'artifact.write' && !observedCalls.has(call.id))) {
    const result = call.resultRef ? store.readBlob<{ effects?: { verified: boolean; changed?: string[]; changedCount?: number } }>(call.resultRef) : undefined;
    const effects = result?.effects;
    if (effects?.verified && Array.isArray(effects.changed)) {
      for (const entry of effects.changed) if (entry !== '.') changedPaths.add(entry);
      if (effects.changed.length !== effects.changedCount) changedFilesComplete = false;
    } else changedFilesComplete = false;
  }
  const result = source.resultRef ? store.readBlob<{ quality?: { status?: string; evidenceRef?: string } }>(source.resultRef) : undefined;
  const checked = store.latestEvent(source.id, { types: ['completion.checked'] });
  const hostStatus = result?.quality?.status ?? (checked?.data.qualityPassed === true ? 'passed' : checked?.data.qualityPassed === false ? 'failed' : 'not_checked');
  const evidenceRef = result?.quality?.evidenceRef ?? checked?.data.evidenceRef;
  return {
    runStatus: source.status, reportCompleteness: { status: reportCompleteness(store, source).status },
    hostAcceptance: { status: hostStatus, ...(typeof evidenceRef === 'string' ? { evidenceRef } : {}) },
    mainAcceptance: { status: 'not_recorded' }, toolsUsed, changedFiles: changedPaths.size, changedPaths: [...changedPaths].sort(), changedFilesComplete,
  };
}

/** Proposals are internal bookkeeping. Only a host user-action API can approve and register one. */
export class AgentRetention {
  readonly mode: AgentRetentionMode;
  private readonly ownerId: string;
  constructor(private readonly store: Store, private readonly options: AgentRetentionOptions = {}) {
    this.mode = options.mode ?? 'review';
    this.ownerId = options.ownerId ?? 'local';
    if (!['review', 'off'].includes(this.mode) || !this.ownerId || this.ownerId.length > 200) throw fail('CONFIG', 'retention mode must be review or off and ownerId must be nonempty');
  }

  list(sessionId?: string): RetentionDraft[] {
    const muted = this.store.agentDrafts.skipCount(this.ownerId) >= 2;
    return this.store.agentDrafts.list(this.ownerId, sessionId).map(row => { const draft = JSON.parse(row.data) as RetentionDraft; return { ...draft, silent: draft.silent || muted }; });
  }
  get(draftId: string): RetentionDraft {
    const row = this.store.agentDrafts.get(draftId);
    if (!row || row.ownerId !== this.ownerId) throw fail('DRAFT', 'retention draft is not available to this host owner');
    return JSON.parse(row.data) as RetentionDraft;
  }

  propose(sessionId: string, request: RetentionMetadata & { run_id: string }, requesterRunId?: string): RetentionDraft {
    this.enabled();
    const { run_id: sourceId, ...details } = request;
    const input = metadata(details);
    const source = this.store.run(sourceId);
    if (source.sessionId !== sessionId || !source.parentId) throw fail('SOURCE', 'proposal source must be an actual child run of this session');
    if (requesterRunId) this.assertMain(requesterRunId, sessionId);
    const used = this.store.calls(source.id).some(call => call.kind === 'model' && call.status !== 'planned');
    if (!used) throw fail('SOURCE', 'source child has not actually executed a model attempt');
    return this.store.transaction(() => {
      const previousRow = this.store.agentDrafts.forSource(sessionId, sourceId);
      const previous = previousRow ? this.get(previousRow.id) : undefined;
      const draft = this.build(source, input, previous);
      this.put(draft);
      this.store.event(draft.ownerRun, 'agent.proposed', { draft_id: draft.id, draft_digest: draft.digest, source_run: source.id, status: draft.status, silent: draft.silent, revision: draft.revision });
      return draft;
    });
  }

  requestRetention(sessionId: string, request: { draft_id: string; digest: string }, requesterRunId?: string): RetentionDraft {
    this.enabled();
    if (requesterRunId) this.assertMain(requesterRunId, sessionId);
    return this.store.transaction(() => {
      const current = this.match(request.draft_id, request.digest);
      if (current.sessionId !== sessionId) throw fail('DRAFT', 'draft belongs to another session');
      if (current.status === 'approved') return current;
      if (current.status === 'rejected' || this.store.agentDrafts.declined(current.id, current.digest)) throw fail('DECLINED', 'the user already declined this draft revision; it remains available in the host draft list');
      const next = { ...current, status: 'requested' as const, silent: current.silent || this.store.agentDrafts.skipCount(this.ownerId) >= 2, updatedAt: new Date().toISOString() };
      this.put(next);
      this.store.event(next.ownerRun, 'agent.retention_requested', { draft_id: next.id, draft_digest: next.digest, requiresUserAction: true, silent: next.silent });
      return next;
    });
  }

  approve(draftId: string, expectedDigest: string, action: RetentionUserAction): RetentionDraft {
    return this.store.transaction(() => {
      const current = this.match(draftId, expectedDigest);
      if (this.actionAlreadyApplied(current, action, 'approve')) return current;
      const parsed = this.validate(current.cardContent, current.card);
      if (parsed.digest !== current.card.digest) throw fail('DIGEST', 'draft card changed; edit and confirm the new digest');
      if (this.options.registerCard) this.options.registerCard(parsed);
      else this.store.registerCard(parsed);
      const next = { ...current, status: 'approved' as const, updatedAt: new Date().toISOString() };
      this.put(next);
      this.recordAction(next, action, 'approve');
      this.store.agentDrafts.resetSkips(this.ownerId);
      return next;
    });
  }

  decide(draftId: string, expectedDigest: string, decision: 'reject' | 'skip' | 'edit', action: RetentionUserAction): RetentionDraft {
    if (!['reject', 'skip', 'edit'].includes(decision)) throw fail('DECISION', 'use reject, skip or edit');
    return this.store.transaction(() => {
      const current = this.match(draftId, expectedDigest);
      if (this.actionAlreadyApplied(current, action, decision)) return current;
      if (current.status === 'approved' && decision !== 'edit') throw fail('DECISION', 'an approved card is already registered; rejecting a draft does not remove a registered version');
      const next = { ...current, status: decision === 'reject' ? 'rejected' as const : decision === 'edit' ? 'editing' as const : 'draft' as const, updatedAt: new Date().toISOString() };
      if (decision === 'edit') this.store.agentDrafts.resetSkips(this.ownerId);
      else if (!this.store.agentDrafts.declined(current.id, current.digest)) this.store.agentDrafts.skipped(this.ownerId);
      next.silent = this.store.agentDrafts.skipCount(this.ownerId) >= 2;
      this.put(next);
      this.recordAction(next, action, decision === 'skip' ? 'reject' : decision, decision);
      return next;
    });
  }

  edit(draftId: string, expectedDigest: string, changes: Partial<RetentionMetadata>): RetentionDraft {
    this.enabled();
    return this.store.transaction(() => {
      const previous = this.match(draftId, expectedDigest);
      const card = previous.card;
      const input = metadata({ name: previous.name, ...(card.catalog ? { catalog: card.catalog } : {}), ...(card.routing ? { routing: card.routing } : {}), ...(previous.reason ? { reason: previous.reason } : {}), ...changes });
      const draft = this.build(this.store.run(previous.sourceRun), input, previous);
      this.put(draft);
      this.store.event(draft.ownerRun, 'agent.draft_edited', { draft_id: draft.id, previous_digest: previous.digest, draft_digest: draft.digest, approvalRequired: true });
      return draft;
    });
  }

  private build(source: Run, input: RetentionMetadata, previous?: RetentionDraft): RetentionDraft {
    const original = source.card;
    const session = this.store.session(source.sessionId);
    const permissions = session.permissions.filter(permission => (source.permissions ?? session.permissions).includes(permission) && (original.constraints?.permissions ?? session.permissions).includes(permission));
    const mode = original.routing?.mode ?? (permissions.includes('write') ? 'write' : permissions.includes('exec') ? 'review' : 'read');
    const routing = input.routing ?? original.routing ?? { use_when: [original.description ?? input.name], mode };
    if (routing.mode !== mode) throw fail('MODE', 'proposal routing mode must match the actually executed member');
    const id = previous?.id ?? randomUUID();
    const revision = (previous?.revision ?? -1) + 1;
    const catalog = input.catalog ?? original.catalog ?? { path: 'retained/general' };
    const constraints = { ...original.constraints, permissions, ...(source.scope ? { scope: structuredClone(source.scope) } : {}) };
    const retained: Card = { ...structuredClone(original), schemaVersion: 2, id: `user/retained-${id}`, version: `0.1.${revision}`, name: input.name, description: original.description ?? input.name, catalog, routing, constraints, members: [] };
    const cardContent = serializeCard(retained);
    safeOutput(cardContent, hostPrivateValues(this.store, source));
    if (input.reason) safeOutput(input.reason, hostPrivateValues(this.store, source));
    const card = this.validate(cardContent, original);
    const evidence = sourceEvidence(this.store, source);
    const now = new Date().toISOString();
    const draftDigest = digest(JSON.stringify({ cardDigest: card.digest, sourceRun: source.id, evidence, revision, reason: input.reason ?? null }));
    return {
      id, draftId: id, digest: draftDigest, revision, sessionId: source.sessionId, sourceRun: source.id, ownerRun: source.parentId!,
      name: input.name, card, cardContent, evidence, ...(input.reason ? { reason: input.reason } : {}), status: 'draft',
      silent: this.store.agentDrafts.skipCount(this.ownerId) >= 2, createdAt: previous?.createdAt ?? now, updatedAt: now,
    };
  }
  private validate(content: string, source: Card): Card {
    const parsed = parseCard(content, { toolNames: source.tools, skillIds: source.skills });
    this.options.validateCard?.(parsed);
    return parsed;
  }
  private enabled(): void { if (this.mode === 'off') throw fail('DISABLED', 'agent retention is disabled by the host'); }
  private assertMain(runId: string, sessionId: string): void {
    const run = this.store.run(runId);
    if (run.parentId || run.sessionId !== sessionId) throw fail('ROLE', 'only the session main agent may propose or request retaining a member');
  }
  private match(id: string, expectedDigest: string): RetentionDraft {
    const draft = this.get(id);
    if (draft.digest !== expectedDigest) throw fail('DIGEST', 'draft changed; review and confirm its current digest');
    return draft;
  }
  private put(draft: RetentionDraft): void {
    this.store.agentDrafts.put({ id: draft.id, sessionId: draft.sessionId, sourceRun: draft.sourceRun, ownerId: this.ownerId, digest: draft.digest, status: draft.status, data: JSON.stringify(draft) });
  }
  private actionAlreadyApplied(draft: RetentionDraft, action: RetentionUserAction, decision: string): boolean {
    if (!action || !['terminal_key', 'web_button', 'conversation', 'cli', 'workbench'].includes(action.source) || typeof action.userEventId !== 'string' || !action.userEventId.trim() || action.userEventId.length > 200) throw fail('ACTION', 'an explicit host user action with source and unique userEventId is required');
    const previous = this.store.agentDrafts.action(action.userEventId);
    if (!previous) return false;
    if (previous.draftId !== draft.id || previous.digest !== draft.digest || previous.decision !== decision) throw fail('ACTION', 'user event was already used for a different draft decision');
    return true;
  }
  private recordAction(draft: RetentionDraft, action: RetentionUserAction, decision: 'approve' | 'reject' | 'edit', originalDecision: 'approve' | 'reject' | 'skip' | 'edit' = decision): void {
    const source = action.source === 'cli' ? 'terminal_key' : action.source === 'workbench' ? 'web_button' : action.source;
    this.store.agentDrafts.recordAction(action.userEventId, draft.id, draft.digest, originalDecision);
    this.store.event(draft.ownerRun, 'agent.approval', { draft_id: draft.id, draft_digest: draft.digest, decision, source, user_event_id: action.userEventId, ...(originalDecision === 'skip' ? { skipped: true } : {}) });
  }
}

/** Tools only create proposals or confirmation requests; no model-facing approval operation exists. */
export function retentionTools(retention: AgentRetention): ToolRegistration[] {
  return [
    {
      name: 'agent.propose', version: '1', permission: 'read', effect: 'read', available: retention.mode !== 'off',
      description: 'Propose retaining a member that actually ran in this session. The kernel copies its exact tools, constraints and private method into a reviewable draft. Only name and routing/catalog metadata are supplied here. This does not register a card or authorize retention; the host asks the user after the task finishes.',
      parameters: { type: 'object', additionalProperties: false, required: ['run_id', 'name'], properties: { run_id: { type: 'string', minLength: 1 }, ...metadataProperties } },
      execute({ run, session, signal }, args) {
        signal.throwIfAborted();
        const draft = retention.propose(session.id, args as unknown as RetentionMetadata & { run_id: string }, run.id);
        return { draft_id: draft.id, digest: draft.digest, name: draft.name, evidence: draft.evidence, status: draft.status, silent: draft.silent, registered: false };
      },
    },
    {
      name: 'agent.retain', version: '1', permission: 'read', effect: 'read', available: retention.mode !== 'off',
      description: 'Request host confirmation of this exact draft digest after the user expresses interest in retaining it. This request is not approval: only an explicit user action in the host can register the card. Never infer authorization from a user message merely being present.',
      parameters: { type: 'object', additionalProperties: false, required: ['draft_id', 'digest'], properties: { draft_id: { type: 'string', minLength: 1 }, digest: { type: 'string', pattern: '^[a-f0-9]{64}$' } } },
      execute({ run, session, signal }, args) {
        signal.throwIfAborted();
        const draft = retention.requestRetention(session.id, args as unknown as { draft_id: string; digest: string }, run.id);
        return { draft_id: draft.id, digest: draft.digest, status: draft.status, silent: draft.silent, requiresUserAction: draft.status !== 'approved' };
      },
    },
  ];
}
