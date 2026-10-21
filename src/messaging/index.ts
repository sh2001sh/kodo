import { Ajv } from 'ajv';
import { randomUUID } from 'node:crypto';
import { Store } from '../storage/index.js';
import { initialContext } from '../runtime/context.js';
import { inspectRun } from '../runtime/inspection.js';
import { KodoError, terminal } from '../runtime/types.js';
import type { Envelope, Run, ToolSpec, Wait } from '../runtime/types.js';

const object = (properties: Record<string, unknown>, required = Object.keys(properties)): Record<string, unknown> => ({ type: 'object', additionalProperties: false, properties, required });
const id = { type: 'string', minLength: 1, maxLength: 256 };
const ids = { type: 'array', items: id, uniqueItems: true, maxItems: 16 };
const content = { type: 'string', minLength: 1, maxLength: 16_000 };
const definitions: (ToolSpec & { main?: boolean; control?: boolean })[] = [
  { name: 'spawn_agent', main: true, description: 'Create an independent child task. Omit BOTH card_id and card_version to inherit the current card. Specifying them selects an already registered immutable card, never creates a card. Inherits model and at most current permissions. Only main can spawn. Include objective, inputs, constraints, responsible scope and acceptance in context. No conversation history is copied; workspace is shared, so coordinate conflicting writes.', parameters: object({ objective: content, context: content, card_id: { ...id, description: 'Existing registered card ID only; omit with card_version to inherit.' }, card_version: { ...id, description: 'Existing immutable version, required with card_id; omit both to inherit.' }, permissions: { type: 'array', uniqueItems: true, items: { enum: ['read', 'write', 'exec'] } }, continuation_of: id }, ['objective']) },
  { name: 'list_agents', description: 'List session task IDs, objectives, status, result availability and decision versions. Read managed results and tool evidence with inspect_run, not history.read. Does not wait or poll models.', parameters: object({}) },
  { name: 'inspect_run', description: 'Read your own or main-managed child run result and paginated tool evidence, even without a context archive. Omit call_id for result and tool-call index; select a returned call_id for actual evidence. Follow next cursors. Does not expose model records, private arguments or arbitrary blobs. completed is not acceptance; tool success is not process exit zero. Peers must explicitly share results. history.read is for indexed archives; artifact.read is for artifact IDs.', parameters: object({ run_id: id, call_id: id, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, content_offset: { type: 'integer', minimum: 0 }, max_chars: { type: 'integer', minimum: 256, maximum: 32000 } }, ['run_id']) },
  { name: 'send_message', description: 'Send a question, answer or notice directly to another run in this session. Answers require reply_to question ID. Sender is runtime controlled. Terminal targets return explicit status.', parameters: object({ to: id, kind: { enum: ['question', 'answer', 'notice'] }, content, reply_to: id, artifacts: ids, message_id: id }, ['to', 'kind', 'content']) },
  { name: 'wait_for_events', control: true, description: 'Durably wait for answers to your question IDs or terminal run IDs, with any/all semantics. Questions and user changes can wake early. Must be last tool and only control call. Returns registration; wake evidence arrives in the next model input.', parameters: object({ question_ids: ids, run_ids: ids, mode: { enum: ['any', 'all'] }, timeout_ms: { type: 'integer', minimum: 1, maximum: 300_000 } }, []) },
  { name: 'ask_user', main: true, control: true, description: 'Ask the user a necessary question and durably wait for a reply. Repeating the same unanswered question reuses it. Only main agent. Must be last tool and only control call.', parameters: object({ question: content }) },
  { name: 'cancel_agent', main: true, description: 'Cancel a child managed by this main agent. Late results cannot reopen it.', parameters: object({ run_id: id }) },
];
const ajv = new Ajv({ allErrors: true });
const schemas = new Map(definitions.map(x => [x.name, ajv.compile(x.parameters)]));
export const collaborationTool = (name: string): boolean => schemas.has(name);
export const controlTool = (name: string): boolean => Boolean(definitions.find(x => x.name === name)?.control);

export class Mailbox {
  constructor(private store: Store, private cancel: (id: string) => void) {}
  specs(run: Run): ToolSpec[] { return definitions.filter(x => !x.main || !run.parentId).map(({ name, description, parameters }) => ({ name, description, parameters })); }
  validate(run: Run, name: string, json: string): Record<string, unknown> {
    if (!this.specs(run).some(x => x.name === name)) throw new KodoError('ROLE_DENIED', 'this collaboration operation is not available to a child');
    let args: unknown;
    try { args = JSON.parse(json); } catch { throw new KodoError('TOOL_ARGUMENTS', 'arguments must be complete JSON'); }
    if (!schemas.get(name)?.(args)) throw new KodoError('TOOL_ARGUMENTS', 'arguments do not match collaboration tool schema');
    return args as Record<string, unknown>;
  }
  execute(run: Run, callId: string, name: string, args: Record<string, unknown>): unknown {
    if (name === 'spawn_agent') return this.spawn(run, args);
    if (name === 'inspect_run') return inspectRun(this.store, run, args as unknown as Parameters<typeof inspectRun>[2]);
    if (name === 'list_agents') {
      const messages = this.store.messages(run.sessionId);
      const identities = this.recoveryIdentities(run);
      return {
        agents: this.store.listRuns(run.sessionId).map(x => ({ id: x.id, parentId: x.parentId, objective: run.parentId && !x.parentId ? 'Main coordinator' : x.objective, status: x.status, resultAvailable: Boolean(x.resultRef), decisionVersion: x.decisionVersion ?? 0, stale: (x.decisionVersion ?? 0) < (this.store.session(run.sessionId).decisionVersion ?? 0) })),
        open_questions: messages.filter(x => x.kind === 'question' && (identities.has(x.from) || identities.has(x.to)) && !messages.some(y => y.kind === 'answer' && y.replyTo === x.id)),
      };
    }
    if (name === 'send_message') {
      const originalTarget = this.peer(run, args.to as string);
      const target = this.recoveryTarget(originalTarget);
      if (terminal(target.status)) return { target_status: target.status, delivered: false };
      if (target.id === run.id) throw new KodoError('MESSAGE_TARGET', 'send to another run');
      const replyTo = args.reply_to as string | undefined;
      if (args.kind === 'answer') {
        const question = replyTo ? this.store.message(replyTo) : undefined;
        if (!question || question.sessionId !== run.sessionId || question.kind !== 'question' || !this.recoveryIdentities(run).has(question.to) || !this.recoveryIdentities(target).has(question.from)) throw new KodoError('REPLY_DENIED', 'answer must reference a question addressed to this sender by this recipient');
        const existing = this.store.answer(question.id);
        if (existing) return { id: existing.id, status: 'already_answered' };
      } else if (replyTo) throw new KodoError('REPLY_DENIED', 'reply_to is only valid for answers');
      for (const artifact of args.artifacts as string[] ?? []) this.store.readArtifact(run.id, artifact);
      const message = this.store.putMessage({ id: `${run.id}:${args.message_id as string ?? callId}`, sessionId: run.sessionId, from: run.id, to: target.id, kind: args.kind as Envelope['kind'], content: args.content as string, ...(replyTo ? { replyTo } : {}), ...(args.artifacts ? { artifacts: args.artifacts as string[] } : {}) });
      this.refresh(target.id);
      return { id: message.id, delivered: true, target_status: this.store.run(target.id).status, ...(target.id === originalTarget.id ? {} : { routed_from: originalTarget.id, to: target.id }) };
    }
    if (name === 'cancel_agent') {
      const child = this.peer(run, args.run_id as string);
      if (child.parentId !== run.id) throw new KodoError('ROLE_DENIED', 'can only cancel children managed by this main run');
      this.cancel(child.id);
      return { id: child.id, status: this.store.run(child.id).status };
    }
    if (name === 'ask_user') {
      const text = args.question as string;
      const normalized = text.trim().replace(/\s+/g, ' ');
      const identities = this.recoveryIdentities(run);
      const existing = this.userQuestions(run.sessionId).find(x => identities.has(x.from) && x.content.trim().replace(/\s+/g, ' ') === normalized);
      const question = existing ?? this.store.putMessage({ id: `question:${callId}`, sessionId: run.sessionId, from: run.id, to: 'user', kind: 'question', content: text });
      return this.register(run, { question_ids: [question.id], timeout_ms: 300_000 });
    }
    if (name === 'wait_for_events') return this.register(run, args);
    throw new KodoError('TOOL_NOT_FOUND', 'unknown collaboration tool');
  }
  private spawn(parent: Run, args: Record<string, unknown>): unknown {
    const session = this.store.session(parent.sessionId);
    if (this.store.listRuns(session.id).filter(x => x.parentId).length >= session.budget.maxChildren) throw new KodoError('CHILD_BUDGET', 'session child creation limit reached');
    if (Boolean(args.card_id) !== Boolean(args.card_version)) throw new KodoError('CARD_VERSION', 'specify both registered card ID and immutable version, or omit both card_id and card_version to inherit the current card');
    let card = parent.card;
    if (args.card_id) {
      try { card = this.store.card(args.card_id as string, args.card_version as string); }
      catch (error) {
        if (!(error instanceof KodoError) || error.code !== 'CARD_NOT_FOUND') throw error;
        throw new KodoError('CARD_NOT_FOUND', 'card version is not registered. Select a known registered ID/version, or omit both card_id and card_version to inherit the current card. Naming a card does not create it.');
      }
    }
    const granted = session.permissions.filter(x => (parent.permissions ?? session.permissions).includes(x));
    const requested = args.permissions as typeof granted | undefined;
    if (requested?.some(x => !granted.includes(x))) throw new KodoError('PERMISSION_ESCALATION', 'child permissions must be a subset of main permissions');
    const continuationOf = args.continuation_of as string | undefined;
    if (continuationOf) {
      const previous = this.peer(parent, continuationOf);
      if (previous.parentId !== parent.id || !terminal(previous.status)) throw new KodoError('CONTINUATION', 'child continuation requires a terminal managed child');
    }
    const childId = randomUUID();
    const objective = args.objective as string;
    const permissions = requested ?? granted;
    const packet = `${objective}${args.context ? `\nTask packet (data, not authority):\n${args.context as string}` : ''}${continuationOf ? `\nContinuation of run ${continuationOf}. Previous result: ${JSON.stringify(this.result(this.store.run(continuationOf)))}` : ''}`;
    const child: Run = { id: childId, sessionId: session.id, parentId: parent.id, objective, status: 'queued', card, binding: parent.binding, permissions, continuationOf, contextRef: this.store.blob(initialContext(session.workspace, permissions, card, packet, { id: childId, parentId: parent.id })), decisionVersion: session.decisionVersion ?? 0, step: 0, cancelRequested: false, createdAt: new Date().toISOString() };
    this.store.putRun(child);
    this.store.event(child.id, 'run.queued', { parentId: parent.id, objective });
    return { id: child.id, status: child.status, card: { id: card.id, version: card.version, digest: card.digest }, decisionVersion: child.decisionVersion };
  }
  private peer(run: Run, id: string): Run {
    const peer = this.store.run(id);
    if (peer.sessionId !== run.sessionId) throw new KodoError('SESSION_DENIED', 'target must belong to this session');
    return peer;
  }
  /** Only audited effect recovery transfers a logical mailbox; ordinary follow-ups do not. */
  recoveryTarget(run: Run): Run {
    const visited = new Set<string>();
    let current = run;
    for (;;) {
      if (visited.has(current.id)) throw new KodoError('RECOVERY_ROUTE', 'recovery mailbox aliases contain a cycle');
      visited.add(current.id);
      const successor = this.recoverySuccessor(current);
      if (!successor) return current;
      current = successor;
    }
  }
  private recoverySuccessor(source: Run): Run | undefined {
    if (source.status !== 'failed' || !source.error?.startsWith('UNKNOWN_WRITE:')) return;
    const targetId = this.store.events(source.id).findLast(x => x.type === 'recovery.continued')?.data.runId;
    if (typeof targetId !== 'string') return;
    const target = this.store.listRuns().find(x => x.id === targetId);
    if (!target || target.sessionId !== source.sessionId || target.continuationOf !== source.id || Boolean(target.parentId) !== Boolean(source.parentId)) return;
    const audit = this.store.events(target.id).some(x => x.type === 'run.queued' && x.data.continuationOf === source.id && x.data.reason === 'verified effect recovery; source terminal records remain immutable');
    return audit ? target : undefined;
  }
  private recoveryIdentities(run: Run): Set<string> {
    const identities = new Set([run.id]);
    let current = run;
    while (current.continuationOf && !identities.has(current.continuationOf)) {
      const previous = this.store.run(current.continuationOf);
      if (this.recoverySuccessor(previous)?.id !== current.id) break;
      identities.add(previous.id);
      current = previous;
    }
    return identities;
  }
  private register(run: Run, args: Record<string, unknown>): unknown {
    const questionIds = args.question_ids as string[] ?? [];
    const runIds = args.run_ids as string[] ?? [];
    if (!questionIds.length && !runIds.length) throw new KodoError('WAIT_ARGUMENTS', 'wait requires question_ids or run_ids');
    for (const id of questionIds) {
      const question = this.store.message(id);
      if (!question || question.sessionId !== run.sessionId || !this.recoveryIdentities(run).has(question.from) || question.kind !== 'question') throw new KodoError('WAIT_DENIED', 'can only wait for answers to your own questions');
    }
    for (const id of runIds) {
      const peer = this.peer(run, id);
      if (this.recoveryTarget(peer).id === run.id) throw new KodoError('WAIT_DENIED', 'cannot wait for your own completion');
    }
    const wait: Wait = { id: randomUUID(), runId: run.id, questionIds, runIds, mode: args.mode as 'any' | 'all' ?? 'any', deadline: Date.now() + (args.timeout_ms as number ?? 60_000), status: 'registered' };
    this.store.putWait(wait);
    this.store.updateRun(run.id, { waitId: wait.id });
    this.store.event(run.id, 'wait.registered', { waitId: wait.id, deadline: wait.deadline });
    this.refresh(run.id);
    this.detectDeadlocks(run.sessionId);
    return { status: 'wait_registered', waitId: wait.id, deadline: wait.deadline };
  }
  refresh(runId: string): void {
    const run = this.store.run(runId);
    if (!run.waitId || terminal(run.status)) return;
    const wait = this.store.wait(run.waitId);
    if (wait.status !== 'registered') return;
    const conditions = [
      ...wait.questionIds.map(id => {
        const question = this.store.message(id)!;
        const answer = this.store.answer(id);
        const peer = question.to === 'user' ? undefined : this.recoveryTarget(this.store.run(question.to));
        return { questionId: id, answerId: answer?.id, peerStatus: peer?.status, ready: Boolean(answer) || Boolean(peer && (terminal(peer.status) || peer.status === 'interrupted')) };
      }),
      ...wait.runIds.map(id => { const peer = this.recoveryTarget(this.store.run(id)); return { runId: id, ...(peer.id === id ? {} : { recoveredRunId: peer.id }), status: peer.status, decisionVersion: peer.decisionVersion ?? 0, ready: terminal(peer.status) || peer.status === 'interrupted' }; }),
    ];
    const ready = wait.mode === 'all' ? conditions.every(x => x.ready) : conditions.some(x => x.ready);
    const input = this.store.inbox(run.id).some(x => ['question', 'input', 'decision'].includes(x.kind));
    if (ready || input || Date.now() >= wait.deadline) this.settle(wait, ready ? 'conditions_met' : input ? 'new_input' : 'timeout', conditions);
  }
  refreshAll(sessionId?: string): void { this.store.transaction(() => { for (const wait of this.store.waits(sessionId, true)) this.refresh(wait.runId); }); }
  private settle(wait: Wait, reason: string, details: unknown = []): void {
    this.store.putWait({ ...wait, status: 'settled', reason });
    const run = this.store.run(wait.runId);
    this.store.putMessage({ id: `wake:${wait.id}`, sessionId: run.sessionId, from: 'runtime', to: run.id, kind: 'event', content: JSON.stringify({ waitId: wait.id, reason, details }) });
    if (run.status === 'waiting') this.store.updateRun(run.id, { status: 'queued' });
    this.store.event(run.id, 'wait.settled', { waitId: wait.id, reason });
  }
  private detectDeadlocks(sessionId: string): void {
    const waits = this.store.waits(sessionId, true).filter(x => !terminal(this.store.run(x.runId).status));
    const gates = this.store.listRuns(sessionId, 'queued').filter(x => x.continuationOf && !terminal(this.store.run(x.continuationOf).status));
    const blocked = new Set([...waits.map(x => x.runId), ...gates.map(x => x.id)]);
    // Greatest fixed point: an any-wait needs every alternative blocked; an all-wait needs one blocker.
    let changed = true;
    while (changed) {
      changed = false;
      for (const gate of gates) if (blocked.has(gate.id) && !blocked.has(gate.continuationOf!)) { blocked.delete(gate.id); changed = true; }
      for (const wait of waits) {
        if (!blocked.has(wait.runId)) continue;
        const deps = [
          ...wait.runIds.map(id => this.recoveryTarget(this.store.run(id))).filter(peer => !terminal(peer.status) && peer.status !== 'interrupted').map(peer => peer.id),
          ...wait.questionIds.filter(id => {
            const question = this.store.message(id)!;
            const peer = question.to === 'user' ? undefined : this.recoveryTarget(this.store.run(question.to));
            return !this.store.answer(id) && (!peer || (!terminal(peer.status) && peer.status !== 'interrupted'));
          }).map(id => { const target = this.store.message(id)!.to; return target === 'user' ? target : this.recoveryTarget(this.store.run(target)).id; }),
        ];
        const stuck = wait.mode === 'all' ? deps.some(id => blocked.has(id)) : deps.every(id => blocked.has(id));
        if (!stuck) { blocked.delete(wait.runId); changed = true; }
      }
    }
    for (const wait of waits) if (blocked.has(wait.runId)) {
      this.settle(wait, 'deadlock', { runs: [...blocked] });
      const run = this.store.run(wait.runId);
      this.store.event(run.id, 'wait.deadlock', { runs: [...blocked] });
      if (run.parentId && !terminal(this.store.run(run.parentId).status)) {
        this.store.putMessage({ id: `deadlock:${wait.id}`, sessionId: run.sessionId, from: 'runtime', to: run.parentId, kind: 'event', content: JSON.stringify({ reason: 'deadlock', runs: [...blocked] }) });
        const parent = this.store.run(run.parentId);
        if (blocked.has(parent.id) && parent.waitId && this.store.wait(parent.waitId).status === 'registered') this.settle(this.store.wait(parent.waitId), 'deadlock');
      }
    }
  }
  onTerminal(runId: string): void {
    const run = this.store.run(runId);
    if (run.waitId) {
      const wait = this.store.wait(run.waitId);
      if (wait.status === 'registered') this.store.putWait({ ...wait, status: 'settled', reason: run.status });
    }
    if (run.parentId && !terminal(this.store.run(run.parentId).status)) {
      const result = this.result(run) as { text?: string; quality?: { status?: string } };
      let text = result.text ?? run.error ?? '';
      const secret = process.env[run.binding.apiKeyEnv];
      if (secret) text = text.replaceAll(secret, '[REDACTED]');
      let end = Math.min(text.length, 1200);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
      this.store.putMessage({ id: `terminal:${run.id}`, sessionId: run.sessionId, from: 'runtime', to: run.parentId, kind: 'event', content: JSON.stringify({ runId, status: run.status, summary: text.slice(0, end), summaryTruncated: end < text.length, quality: { status: result.quality?.status ?? 'not_checked' }, inspect: { run_id: run.id }, decisionVersion: run.decisionVersion ?? 0 }) });
    }
    this.refreshAll(run.sessionId);
  }
  result(run: Run): unknown { return run.resultRef ? this.store.readBlob(run.resultRef) : { status: run.status, error: run.error }; }
  userQuestions(sessionId: string): Envelope[] {
    return this.store.unansweredQuestions(sessionId, 'user').filter(x => !terminal(this.recoveryTarget(this.store.run(x.from)).status));
  }
}
