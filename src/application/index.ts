import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { defaultCard } from '../agents/card.js';
import { RunCoordinator } from '../runtime/coordinator.js';
import { defaultBudget, KodoError, terminal } from '../runtime/types.js';
import { resolveModelLimits, validateModelBinding } from '../providers/model-limits.js';
import { discoverModelLimits } from '../providers/model-discovery.js';
import { initialContext } from '../runtime/context.js';
import type { Budget, Card, CompletionValidator, Message, ModelBinding, Permission, Provider, ResolvedModelLimits, Run } from '../runtime/types.js';
import type { ReadOnlyCommand } from '../tools/index.js';
import type { RecoveryOutcome, RecoveryPlan } from '../runtime/recovery.js';
import { Store } from '../storage/index.js';
import { ModelProvider } from '../providers/index.js';

export interface CreateRunOptions { objective: string; workspace: string; binding: ModelBinding; permissions?: Permission[]; budget?: Partial<Budget>; card?: Card; finalResponse?: 'required' | 'optional' }

export class Application {
  readonly store: Store;
  readonly coordinator: RunCoordinator;
  constructor(directory: string, provider: Provider = new ModelProvider(), onText?: (id: string, text: string) => void, options: { readOnlyCommands?: ReadOnlyCommand[] } = {}) {
    this.store = new Store(directory);
    this.coordinator = new RunCoordinator(this.store, provider, onText, options.readOnlyCommands);
  }
  /** Synchronous creation uses declared/catalog limits or clearly marked provisional limits. */
  createRun(options: CreateRunOptions): Run { return this.createResolvedRun(options); }
  /** CLI and hosts can discover endpoint-specific metadata before persisting a session. */
  async createRunWithDiscovery(options: CreateRunOptions, signal?: AbortSignal): Promise<Run> {
    return this.createResolvedRun(options, await discoverModelLimits(options.binding, options.budget, signal));
  }
  private createResolvedRun(options: CreateRunOptions, discovered?: ResolvedModelLimits): Run {
    if (!options.objective.trim() || options.objective.length > 32_000) throw new KodoError('OBJECTIVE', 'provide a nonempty task of at most 32000 characters');
    if (options.finalResponse !== undefined && !['required', 'optional'].includes(options.finalResponse)) throw new KodoError('DELIVERY_CONTRACT', 'finalResponse must be required or optional');
    const workspace = realpathSync(options.workspace);
    if (!statSync(workspace).isDirectory()) throw new KodoError('WORKSPACE', 'workspace must be a directory');
    const nullable = new Set(['maxTokens', 'maxModelCalls', 'maxToolCalls', 'maxDurationMs', 'maxContextChars']);
    for (const [field, value] of Object.entries(options.budget ?? {})) if (!(value === null && nullable.has(field)) && (!Number.isSafeInteger(value) || value! <= 0)) throw new KodoError('BUDGET', 'limits must be positive safe integers; optional session limits may be null');
    validateModelBinding(options.binding);
    const modelLimits = discovered ?? resolveModelLimits(options.binding, options.budget);
    const context = options.budget?.maxContextTokens ?? modelLimits.context;
    const budget: Budget = { ...defaultBudget, maxContextTokens: context, maxOutputTokens: Math.min(modelLimits.output, context - 1), ...options.budget };
    if (budget.maxOutputTokens >= budget.maxContextTokens) throw new KodoError('BUDGET', 'output reservation must leave room for input in the model token window');
    if (budget.maxContextTokens > modelLimits.context || budget.maxOutputTokens > modelLimits.output) throw new KodoError('BUDGET', 'requested context/output exceeds known model limits; declare endpoint-specific binding.limits instead');
    const permissions = options.permissions ?? ['read'];
    if (permissions.some(x => !['read', 'write', 'exec'].includes(x))) throw new KodoError('PERMISSIONS', 'unknown permission');
    const card = options.card ?? defaultCard;
    const sessionId = randomUUID();
    const createdAt = new Date().toISOString();
    const runId = randomUUID();
    const contextRef = this.store.blob(initialContext(workspace, permissions, card, options.objective, { id: runId, finalResponse: options.finalResponse }));
    const run: Run = { id: runId, sessionId, objective: options.objective, status: 'queued', card, binding: options.binding, contextRef, step: 0, cancelRequested: false, decisionVersion: 0, finalResponse: options.finalResponse, createdAt };
    this.store.transaction(() => {
      this.store.registerCard(card);
      this.store.putSession({ id: sessionId, workspace, permissions, budget, modelLimits, tokens: 0, modelCalls: 0, toolCalls: 0, usageEstimated: false, decisionVersion: 0, createdAt });
      this.store.putRun(run);
      this.store.event(run.id, 'run.queued', { objective: options.objective, card: { id: card.id, version: card.version, digest: card.digest } });
    });
    return run;
  }
  run(runId: string): Promise<Run> { return this.coordinator.drive(runId); }
  /** Trusted host validation; callbacks must be reattached after reopening the data directory. */
  setCompletionValidator(runId: string, validator: CompletionValidator): void { this.coordinator.setCompletionValidator(runId, validator); }
  reconcile(runId: string): Promise<RecoveryPlan> { return this.coordinator.recovery.inspect(runId); }
  resolveCall(runId: string, callId: string, options: { outcome: RecoveryOutcome; evidence: string; retry?: boolean }): RecoveryPlan {
    return this.coordinator.recovery.resolve(runId, callId, options);
  }
  recover(runId: string): Promise<Run> {
    const target = this.store.run(runId);
    if (this.coordinator.busy) throw new KodoError('RECOVERY_ACTIVE', 'stop active execution before recovery');
    if (terminal(target.status) && !(target.status === 'failed' && target.error?.startsWith('UNKNOWN_WRITE:'))) throw new KodoError('NOT_INTERRUPTED', 'terminal records remain immutable');
    const recovered = this.store.events(runId).find(event => event.type === 'recovery.continued');
    if (recovered) throw new KodoError('ALREADY_RECOVERED', `recovery already created run ${String(recovered.data.runId)}; inspect or resume that run`);
    const runs = this.store.listRuns(target.sessionId).filter(x => x.status === 'interrupted');
    this.store.transaction(() => { for (const run of runs) this.coordinator.classifyRecovery(run.id); });
    const sources = this.store.listRuns(target.sessionId).filter(run => (run.status === 'interrupted' || (run.status === 'failed' && run.error?.startsWith('UNKNOWN_WRITE:')) || (run.status === 'cancelled' && this.store.calls(run.id).some(call => call.kind === 'tool' && call.effect === 'write' && ['unknown', 'running'].includes(call.status)))));
    const plans = sources.map(run => this.coordinator.recovery.plan(run.id));
    if (plans.some(plan => plan.blocked.length)) throw new KodoError('UNKNOWN_WRITE', 'a write may have completed without a recorded result; reconcile or provide verification evidence before resume');
    let resumedId = runId;
    // Validate and requeue all interrupted peers before any one of them can start side effects.
    this.store.transaction(() => {
      const replacements = new Map<string, string>();
      for (const plan of plans) if (plan.requiresContinuation && !this.store.events(plan.sourceRunId).some(event => event.type === 'recovery.continued')) {
        const source = this.store.run(plan.sourceRunId);
        const id = randomUUID();
        const pending = plan.pendingModelCallId ? plan.calls.find(call => call.id === plan.pendingModelCallId) : undefined;
        if (!pending || pending.status !== 'succeeded') throw new KodoError('RECOVERY_RESPONSE', 'recovery requires a complete persisted response');
        const modelId = randomUUID();
        const session = this.store.session(source.sessionId);
        const permissions = session.permissions.filter(permission => (source.permissions ?? session.permissions).includes(permission));
        const context = this.store.readBlob<Message[]>(source.contextRef);
        const host = initialContext(session.workspace, permissions, source.card, source.objective, { id, parentId: source.parentId, finalResponse: source.finalResponse })[0]!;
        const continuation: Run = { ...source, id, status: 'queued', resultRef: undefined, error: undefined, cancelRequested: false, waitId: undefined, continuationOf: source.id, contextRef: this.store.blob([host, ...context.slice(1)]), stepCallId: modelId, createdAt: new Date().toISOString(), activeMs: 0 };
        this.store.putRun(continuation);
        this.store.putCall({ ...pending, id: modelId, runId: id });
        for (const call of plan.calls) if (call.id.startsWith(`${pending.id}:`)) this.store.putCall({ ...call, id: `${modelId}${call.id.slice(pending.id.length)}`, runId: id });
        for (const message of this.store.inbox(source.id)) this.store.putMessage({ id: `recovery:${id}:${message.id}`, sessionId: source.sessionId, from: message.kind === 'question' ? 'runtime' : message.from, to: id, kind: message.kind === 'question' ? 'event' : message.kind, content: message.kind === 'question' ? JSON.stringify({ reason: 'recovery_delivery', originalMessage: message, note: 'This is the original pending question, not a new question. Answer using originalMessage.id as reply_to.' }) : message.content, ...(message.replyTo ? { replyTo: message.replyTo } : {}), ...(message.artifacts ? { artifacts: message.artifacts } : {}) });
        this.store.event(source.id, 'recovery.continued', { runId: id });
        this.store.event(id, 'run.queued', { continuationOf: source.id, reason: 'verified effect recovery; source terminal records remain immutable' });
        replacements.set(source.id, id);
        if (source.id === runId) resumedId = id;
      }
      for (const peer of this.store.listRuns(target.sessionId)) if ( !terminal(peer.status)) {
        const parentId = peer.parentId ? replacements.get(peer.parentId) : undefined;
        if (parentId) {
          const session = this.store.session(peer.sessionId);
          const permissions = session.permissions.filter(permission => (peer.permissions ?? session.permissions).includes(permission));
          const context = this.store.readBlob<Message[]>(peer.contextRef);
          const host = initialContext(session.workspace, permissions, peer.card, peer.objective, { id: peer.id, parentId })[0]!;
          this.store.updateRun(peer.id, { parentId, contextRef: this.store.blob([host, ...context.slice(1)]) });
          this.store.event(peer.id, 'recovery.reparented', { previousParentId: peer.parentId!, parentId });
        }
        if (replacements.size) this.store.putMessage({ id: `recovery-map:${resumedId}:${peer.id}`, sessionId: peer.sessionId, from: 'runtime', to: peer.id, kind: 'event', content: JSON.stringify({ reason: 'verified recovery created replacement runs; coordinate with these current IDs and review their completion before reporting', replacements: Object.fromEntries(replacements) }) });
      }
      for (const run of runs) this.coordinator.prepareResume(run.id);
    });
    return this.run(resumedId);
  }
  submitInput(runId: string, content: string, options: { mode?: 'steer' | 'follow_up'; decision?: boolean } = {}): Run {
    if (!content.trim() || content.length > 16_000) throw new KodoError('INPUT', 'input must contain 1 to 16000 characters');
    return this.store.transaction(() => {
      let run = this.store.run(runId);
      if (run.parentId) throw new KodoError('INPUT_TARGET', 'user input must target a main run');
      const session = this.store.session(run.sessionId);
      if (terminal(run.status) || options.mode === 'follow_up') {
        const id = randomUUID();
        const permissions = session.permissions.filter(x => (run.permissions ?? session.permissions).includes(x));
        run = { id, sessionId: run.sessionId, objective: content, status: 'queued', card: run.card, binding: run.binding, permissions, continuationOf: run.id, finalResponse: run.finalResponse, contextRef: this.store.blob(initialContext(session.workspace, permissions, run.card, content, { id, finalResponse: run.finalResponse })), step: 0, cancelRequested: false, decisionVersion: session.decisionVersion ?? 0, createdAt: new Date().toISOString() };
        this.store.putRun(run);
        this.store.event(id, 'run.queued', { continuationOf: run.continuationOf });
      }
      if (options.decision) this.recordDecision(run, content);
      else {
        this.store.putMessage({ id: randomUUID(), sessionId: run.sessionId, from: 'user', to: run.id, kind: 'input', content });
        this.coordinator.mailbox.refresh(run.id);
      }
      return this.store.run(run.id);
    });
  }
  answer(questionId: string, content: string, options: { decision?: boolean } = {}): Run {
    if (!content.trim() || content.length > 16_000) throw new KodoError('INPUT', 'answer must contain 1 to 16000 characters');
    return this.store.transaction(() => {
      const question = this.store.message(questionId);
      if (!question || question.to !== 'user' || question.kind !== 'question') throw new KodoError('QUESTION', 'user question not found');
      const run = this.coordinator.mailbox.recoveryTarget(this.store.run(question.from));
      if (terminal(run.status)) throw new KodoError('RUN_ENDED', 'question belongs to a terminal run; submit new input to create a continuation');
      const previous = this.store.answer(question.id);
      if (previous) {
        if (previous.content !== content) throw new KodoError('ANSWER_CONFLICT', 'question already has a different answer');
        return run;
      }
      this.store.putMessage({ id: `answer:${questionId}`, sessionId: run.sessionId, from: 'user', to: run.id, kind: 'answer', content, replyTo: questionId });
      if (options.decision) this.recordDecision(run, content);
      this.coordinator.mailbox.refresh(run.id);
      return this.store.run(run.id);
    });
  }
  private recordDecision(run: Run, content: string): void {
    const session = this.store.session(run.sessionId);
    const version = (session.decisionVersion ?? 0) + 1;
    this.store.putDecision(session.id, version, content);
    this.store.putSession({ ...session, decisionVersion: version });
    this.store.event(run.id, 'decision.updated', { version, content });
    for (const peer of this.store.listRuns(session.id)) if ( !terminal(peer.status)) {
      this.store.putMessage({ id: `decision:${session.id}:${version}:${peer.id}`, sessionId: session.id, from: 'user', to: peer.id, kind: 'decision', content: JSON.stringify({ version, content }) });
      this.coordinator.mailbox.refresh(peer.id);
    }
  }
  updatePermissions(runId: string, permissions: Permission[]): Run {
    return this.store.transaction(() => {
      const run = this.store.run(runId);
      if (run.parentId || terminal(run.status)) throw new KodoError('PERMISSIONS', 'change permissions on an active main run');
      const session = this.store.session(run.sessionId);
      if (permissions.some(x => !session.permissions.includes(x)) || new Set(permissions).size !== permissions.length) throw new KodoError('PERMISSION_ESCALATION', 'runtime permission updates can only revoke existing grants');
      this.store.putSession({ ...session, permissions });
      this.recordDecision(run, `User revoked permissions. Effective session grants: ${permissions.join(', ') || 'none'}.`);
      this.coordinator.revokeSession(session.id);
      return this.store.run(runId);
    });
  }
  snapshot(runId: string): unknown {
    const run = this.store.run(runId);
    const session = this.store.session(run.sessionId);
    return { run, session, runs: this.store.listRuns(session.id).map(x => ({ ...x, stale: (x.decisionVersion ?? 0) < (session.decisionVersion ?? 0) })), calls: this.store.calls(run.id), events: this.store.events(run.id), messages: this.store.messages(session.id), waits: this.store.waits(session.id), questions: this.coordinator.mailbox.userQuestions(session.id), decisions: this.store.decisions(session.id) };
  }
  async shutdown(): Promise<void> { await this.coordinator.shutdown(); this.close(); }
  close(): void {
    if (this.coordinator.busy) throw new KodoError('RUNTIME_ACTIVE', 'await application.shutdown() before closing an active runtime');
    this.store.close();
  }
}
export { ModelProvider, ChatCompletionsProvider, ResponsesProvider, AnthropicProvider } from '../providers/index.js';
export { parseCard, loadCard } from '../agents/card.js';
export { KodoError, defaultBudget } from '../runtime/types.js';
export { resolveModelLimits } from '../providers/model-limits.js';
export { discoverModelLimits } from '../providers/model-discovery.js';
export type { ReadOnlyCommand } from '../tools/index.js';
export type { Provider, ModelResponse, Message, ToolRequest, Run, ModelBinding, ModelLimits, ResolvedModelLimits, ModelProtocol, Budget, CompletionCheck, CompletionValidator } from '../runtime/types.js';
