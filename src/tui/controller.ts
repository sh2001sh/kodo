import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { terminalText } from '../cli/terminal.js';
import { inspectRun } from '../runtime/inspection.js';
import { assertFileScope, actualPath, canAccessFileScope } from '../runtime/scope.js';
import { workspaceWrites } from '../runtime/completion.js';
import { KodoError, errorText, terminal } from '../runtime/types.js';
import type { Call, ModelBinding, Run, RuntimeEvent } from '../runtime/types.js';
import { agentCommand } from './agents.js';
import { createAgentOperations } from './operations.js';
import type { CreateRunOptions } from '../application/index.js';
import { captureVerificationFiles } from './verification-state.js';
import { helpPanel, parseCommand, quoteArgument, statusLabel } from './commands.js';
import type { TuiActions, TuiEntry, TuiItem, TuiOptions, TuiPanel, TuiSnapshot, TuiTask, TuiPermissionMode } from './types.js';

const entryLimit = 300;
const textLimit = 32_000;
const short = (value: string, limit = 160): string => value.length > limit ? `${value.slice(0, limit)}…` : value;
const jsonLines = (value: unknown): string[] => JSON.stringify(value, null, 2).slice(0, textLimit).split('\n');
type ApprovalRequest = { runId: string; callId?: string; name: string; arguments: Readonly<Record<string, unknown>> };

/** UI orchestration over one host Application. Durable runtime state remains authoritative. */
export class TuiController implements TuiActions {
  private readonly listeners = new Set<() => void>();
  private readonly entries = new Map<string, TuiEntry>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly agentPending = new Map<AbortController, Promise<TuiPanel>>();
  private readonly queue: { id: string; content: string }[] = [];
  private readonly unsubscribe: () => void;
  private readonly restored = new Set<string>();
  private readonly historyIds = new Set<string>();
  private readonly processes = new Map<string, TuiTask & { runId: string }>();
  private starting?: Promise<Run>;
  private draining?: Promise<void>;
  private currentId?: string;
  private binding: ModelBinding;
  private modelProvider?: string;
  private modelQuery?: AbortController;
  private modelLoadingPanel?: TuiPanel;
  private panel?: TuiPanel;
  private notice?: string;
  private cursor = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private quitting = false;
  private exiting = false;
  private stoppingSession = false;
  private readonly checks = new Set<AbortController>();
  private paste?: string[];
  private answerTarget?: string;
  private revision = 0;
  private submissions: Promise<void> = Promise.resolve();
  private permissionMode: TuiPermissionMode;
  private permissionMenu = false;
  private readonly approvals = new Map<string, { request: ApprovalRequest; settle: (allowed: boolean) => void }>();
  private readonly releaseApproval: () => void;

  constructor(private readonly options: TuiOptions) {
    this.binding = { ...options.binding };
    this.modelProvider = options.modelConfig?.provider;
    this.permissionMode = options.permissionMode ?? 'ask';
    this.releaseApproval = options.app.coordinator.tools.setApprovalHandler((request, signal) => this.requestApproval(request, signal));
    this.unsubscribe = options.app.store.subscribe(event => {
      const run = this.current();
      if (!run || event.sessionId !== run.sessionId || event.seq <= this.cursor) return;
      this.consume(event);
      this.notify(['run.completed', 'run.failed', 'run.interrupted', 'message.created', 'model.provider_changed'].includes(event.type));
    });
    if (options.initial) {
      this.select(options.initial);
      this.restored.add(options.initial.sessionId);
      queueMicrotask(() => { if (!this.closed) this.wake(options.initial!.id); });
    }
  }

  snapshot(): TuiSnapshot {
    const run = this.current();
    const session = run ? this.options.app.store.session(run.sessionId) : undefined;
    const owners = this.ownedRuns();
    const questions = session ? this.options.app.coordinator.mailbox.userQuestions(session.id).map(question => ({ id: question.id, content: this.clean(question.content) })) : [];
    const latest = run ? this.options.app.store.latestEvent(run.id, { types: ['context.request_measured'] }) : undefined;
    const tokens = typeof latest?.data.estimatedInputTokens === 'number' ? latest.data.estimatedInputTokens : undefined;
    const price = this.options.rates ? 'Rates configured (/context usage)' : 'Rates not configured';
    const usage = session ? `Context ${tokens === undefined ? 'no requests yet' : `${Math.round(tokens / session.budget.maxContextTokens * 100)}% estimated`} · Total ${session.tokens.toLocaleString()} tokens${session.usageEstimated ? ' (includes estimates)' : ''} · ${price}` : `No model requests yet · ${price}`;
    const panel = this.permissionMenu || this.approvals.size ? this.permissionsPanel() : this.panel;
    return {
      workspace: session?.workspace ?? this.options.workspace, model: run?.binding.model || this.binding.model || 'Not configured',
      status: run ? statusLabel[run.status] : 'Ready', ...(run ? { runId: run.id, sessionId: run.sessionId } : {}),
      entries: [...this.entries.values()], tasks: [...owners.filter(peer => peer.id === run?.id || peer.parentId === run?.id).map(peer => ({
        id: peer.id, kind: 'agent' as const, label: peer.parentId ? peer.card.name : 'Main task', status: statusLabel[peer.status],
        detail: `${peer.card.id}@${peer.card.version} · ${this.clean(short(peer.objective))}`, command: `/tasks show ${peer.id}`,
      })), ...this.processes.values()], questions, queue: this.queue.map(item => ({ ...item })),
      ...(panel ? { panel: { ...panel, title: this.clean(panel.title), lines: panel.lines.map(line => this.clean(line)), ...(panel.hint ? { hint: this.clean(panel.hint) } : {}), ...(panel.items ? { items: panel.items.map(item => ({ ...item, label: this.clean(item.label), ...(item.detail ? { detail: this.clean(item.detail) } : {}) })) } : {}) } } : {}), ...(this.notice ? { notice: this.clean(this.notice) } : {}),
      usage, permissionMode: this.permissionMode, busy: Boolean(this.starting) || this.agentPending.size > 0 || this.running.size > 0 || owners.some(peer => peer.status === 'running'), quitting: this.quitting,
    };
  }

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  dismissPanel(): void {
    this.cancelModelQuery();
    if (this.permissionMenu) this.permissionMenu = false;
    else this.approvals.values().next().value?.settle(false);
    this.panel = undefined; this.answerTarget = undefined; this.notify(true);
  }
  onText(runId: string, text: string): void {
    if (this.closed || runId !== this.currentId) return;
    const id = `stream:${runId}`;
    const previous = this.entries.get(id)?.text ?? '';
    this.put({ id, kind: 'assistant', title: 'Kodo', text: (previous + this.clean(text)).slice(-textLimit), status: 'Streaming' });
    this.notify();
  }

  async submit(text: string, input: { literal?: boolean } = {}): Promise<void> {
    if (!input.literal && !this.paste && /^\/(?:stop|cancel|quit|permissions)(?:\s|$)/u.test(text.trim())) return await this.dispatch(text, input);
    const submission = this.submissions.then(() => this.dispatch(text, input));
    this.submissions = submission.catch(() => {});
    await submission;
  }
  private async dispatch(text: string, input: { literal?: boolean }): Promise<void> {
    if (this.closed || this.quitting || this.exiting) return;
    try {
      if (!input.literal && text.trim() === '/paste' && !this.paste) { this.cancelModelQuery(); this.paste = []; this.notice = 'Multiline input; use /send to submit literal text.'; this.notify(true); return; }
      if (this.paste && text.trim() !== '/send') { this.paste.push(text); this.notify(true); return; }
      if (this.paste) { text = this.paste.join('\n'); this.paste = undefined; input = { literal: true }; }
      if (!text.trim()) return;
      this.notice = undefined;
      if (input.literal || !text.trimStart().startsWith('/')) await this.send(text);
      else {
        const [command, ...args] = parseCommand(text.trim());
        await this.command(command!.slice(1), args);
      }
    } catch (error) { this.notice = this.clean(errorText(error)); this.put({ id: `error:${randomUUID()}`, kind: 'error', text: this.notice }); this.notify(true); throw error; }
    this.notify(true);
  }

  async interrupt(): Promise<void> {
    this.cancelModelQuery();
    this.denyApprovals();
    for (const operation of this.agentPending.keys()) operation.abort(new KodoError('TURN_INTERRUPTED', 'Agent operation interrupted by user.'));
    for (const check of this.checks) check.abort(new KodoError('TURN_INTERRUPTED', 'Verification interrupted by user.'));
    const run = this.current();
    if (!run || terminal(run.status) || run.status === 'interrupted') { this.notice = 'No active turn to interrupt.'; this.notify(true); return; }
    this.options.app.coordinator.interrupt(run.id);
    this.notice = 'Interrupting the turn. See /tasks for agents and background processes.'; this.notify(true);
    await this.options.app.coordinator.waitForStop(run.id);
    this.notify(true);
  }
  async quit(confirmed = false): Promise<void> {
    this.cancelModelQuery();
    this.permissionMenu = false; this.denyApprovals();
    const active = this.ownedRuns().filter(run => !terminal(run.status) && run.status !== 'interrupted');
    if (!confirmed && (active.length || this.queue.length || this.checks.size || this.starting || this.agentPending.size || this.ownedRuns().some(run => this.options.app.coordinator.tools.backgroundRunning(run.id) || this.options.app.coordinator.tools.hasInFlightEffects(run.id)))) {
      this.panel = { title: 'Exit Kodo', lines: [`There are ${active.length} active tasks and ${this.queue.length} queued tasks.`, 'Exit interrupts execution and clears the queue after cleanup. Existing file changes are retained.'], items: [
        { id: 'stay', label: 'Return to task', command: '/quit back' }, { id: 'quit', label: 'Interrupt and exit', command: '/quit confirm' },
      ] }; this.notify(true); return;
    }
    this.exiting = true; this.queue.length = 0;
    try {
      try { await this.starting; } catch (error) { this.notice = this.clean(errorText(error)); }
      await this.stopSession('User exit');
      this.quitting = true; this.panel = undefined; this.notify(true);
    } catch (error) { this.exiting = false; this.notice = this.clean(errorText(error)); this.notify(true); throw error; }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.cancelModelQuery();
    this.unsubscribe(); if (this.timer) clearTimeout(this.timer);
    for (const operation of this.agentPending.keys()) operation.abort(new KodoError('TUI_CLOSED', 'The interface is closed.'));
    for (const check of this.checks) check.abort(new KodoError('TUI_CLOSED', 'The interface is closed.'));
    this.closed = true; this.listeners.clear();
    this.denyApprovals();
    await this.stopSession('The interface is closed.');
    this.releaseApproval();
    await Promise.allSettled([...this.agentPending.values()]);
  }

  private async command(name: string, args: string[]): Promise<void> {
    if (name !== 'model') this.cancelModelQuery();
    if (name !== 'permissions') this.permissionMenu = false;
    switch (name) {
      case 'help': this.panel = helpPanel(args[0] === 'keys'); return;
      case 'status': this.panel = this.statusPanel(); return;
      case 'new':
        if (this.hasActive()) throw new KodoError('TUI_ACTIVE', 'Use /stop all before starting a new session.');
        if (this.queue.length) throw new KodoError('TUI_QUEUE', 'Clear the follow-up queue first.');
        this.currentId = undefined; this.entries.clear(); this.processes.clear(); this.panel = undefined; this.answerTarget = undefined;
        this.notice = 'New session ready. Send a task to start; workspace files are retained.'; return;
      case 'resume': await this.resume(args); return;
      case 'model': await this.model(args); return;
      case 'providers': await this.providers(args); return;
      case 'settings': this.settings(args); return;
      case 'permissions': this.permissions(args); return;
      case 'agents': {
        const control = new AbortController();
        const pending = agentCommand({ ...this.options, ...createAgentOperations(this.options, { binding: this.binding, executeRun: (request, signal, purpose, onCreated) => this.executeOperation(request, signal, purpose, onCreated), signal: control.signal }), runId: this.currentId, startTask: objective => this.startTask(objective), wake: id => this.wake(id) }, args);
        this.agentPending.set(control, pending);
        try { this.panel = await pending; } finally { this.agentPending.delete(control); }
        return;
      }
      case 'tasks': await this.tasks(args); return;
      case 'changes': await this.changes(args); return;
      case 'check': await this.check(args); return;
      case 'context': this.context(args); return;
      case 'files': await this.files(args.join(' ')); return;
      case 'stop': if (args[0] === 'all') { await this.stopSession('Session stopped by user'); this.notice = 'Session and background processes stopped. Existing changes are retained; unknown effects still need review.'; } else if (args.length) throw new KodoError('TUI_COMMAND', 'Use /stop or /stop all.'); else await this.interrupt(); return;
      case 'cancel': {
        this.denyApprovals();
        const operations = [...this.agentPending.entries()];
        for (const [control] of operations) control.abort(new KodoError('CANCELLED', 'Agent operation cancelled by user.'));
        const run = this.current();
        if (!run && !operations.length) this.requireRun();
        if (run) { this.options.app.coordinator.cancel(run.id); await this.options.app.coordinator.waitForStop(run.id); }
        await Promise.allSettled(operations.map(([, pending]) => pending));
        this.notice = 'Cancellation requested. Existing file changes are retained.'; return;
      }
      case 'quit': if (args[0] === 'back') this.panel = undefined; else await this.quit(args[0] === 'confirm'); return;
      case 'decision': if (!args.length) throw new KodoError('TUI_INPUT', 'Usage: /decision new constraints'); await this.send(args.join(' '), true); this.notice = 'Decision updated. Earlier plans and results may need review.'; return;
      case 'next': await this.next(args); return;
      case 'send': throw new KodoError('TUI_PASTE', 'Start multiline input with /paste first.');
      default: throw new KodoError('TUI_COMMAND', `Unknown command /${name}; use /help for available commands.`);
    }
  }

  private async send(text: string, decision = false): Promise<void> {
    this.cancelModelQuery();
    if (this.starting) await this.starting;
    if (this.draining) await this.draining;
    if (this.exiting || this.closed) return;
    if (this.checks.size) throw new KodoError('TUI_CHECK_ACTIVE', 'Host verification is running. Wait for its result or queue a task with /next.');
    if (this.answerTarget) {
      const question = this.answerTarget;
      const run = this.requireRun();
      if (!this.options.app.coordinator.mailbox.userQuestions(run.sessionId).some(item => item.id === question)) throw new KodoError('QUESTION', 'The selected question is closed or belongs to another session.');
      await this.ensureRestored(run);
      const answered = this.options.app.answer(question, text, { decision }); this.answerTarget = undefined; this.panel = undefined; this.wake(answered.id); return;
    }
    const current = this.current();
    if (!current) { await this.startTask(text); return; }
    await this.ensureRestored(current);
    if (current.status === 'interrupted') {
      if (!current.interruptRequested) throw new KodoError('RECOVERY_REQUIRED', 'This task requires explicit recovery. Open /resume.');
      this.options.app.coordinator.resumeInterrupted(current.id);
    }
    const next = this.options.app.submitInput(current.id, text, { decision });
    this.currentId = next.id; this.historyIds.add(next.id); this.restored.add(next.sessionId);
    this.panel = undefined; this.revision++; this.wake(next.id);
  }
  private async startTask(objective: string): Promise<void> {
    if (this.hasActive(true)) throw new KodoError('TUI_ACTIVE', 'The current session still has an active main task.');
    this.starting = Promise.resolve().then(() => (this.options.createRun ?? (options => this.options.app.createRun(options)))({ objective, workspace: this.options.workspace, binding: this.binding, permissions: this.options.permissions, budget: this.options.budget, card: this.options.card }));
    try {
      const run = await this.starting;
      this.select(run); this.restored.add(run.sessionId);
      this.panel = undefined; this.wake(run.id);
    } finally { this.starting = undefined; }
  }
  private wake(id: string): void {
    if (this.running.has(id) || this.closed || this.quitting || this.exiting || this.stoppingSession) return;
    const work = (async () => {
      let revision: number;
      do {
        revision = this.revision;
        await this.ensureRestored(this.options.app.store.run(id));
        await this.options.beforeRun?.(id);
        await this.options.app.run(id);
      } while (revision !== this.revision && !terminal(this.options.app.store.run(id).status) && this.options.app.store.run(id).status !== 'interrupted');
    })().catch(error => { this.notice = this.clean(errorText(error)); }).finally(() => {
      this.running.delete(id); this.notify(true);
      const current = this.current(); if (current?.status === 'completed' && !this.quitting && !this.closed && !this.exiting && !this.stoppingSession) void this.drainQueue();
    });
    this.running.set(id, work); this.notify();
  }
  private async executeOperation(request: CreateRunOptions, signal: AbortSignal, purpose?: 'authoring' | 'case', onCreated?: (run: Run) => void): Promise<Run> {
    if (this.hasActive(true) || this.stoppingSession || this.exiting || this.closed) throw new KodoError('TUI_ACTIVE', 'Stop the current session before starting an Agent authoring or case run.');
    signal.throwIfAborted();
    this.starting = Promise.resolve().then(() => this.options.createRun ? this.options.createRun(request, { purpose }) : this.options.app.createRun(request));
    let run: Run;
    try { run = await this.starting; } finally { this.starting = undefined; }
    this.select(run); this.restored.add(run.sessionId); this.notify(true);
    try { onCreated?.(run); } catch (error) { this.options.app.coordinator.cancel(run.id); await this.options.app.coordinator.waitForStop(run.id); throw error; }
    const cancel = (): void => { if (!terminal(this.options.app.store.run(run.id).status)) this.options.app.coordinator.cancel(run.id); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const work = (async () => { await this.options.beforeRun?.(run.id); if (signal.aborted) cancel(); return await this.options.app.run(run.id); })();
    const tracked = work.then(() => {}, () => {}); this.running.set(run.id, tracked);
    try { return await work; }
    finally { signal.removeEventListener('abort', cancel); this.running.delete(run.id); this.notify(true); }
  }
  private async stopSession(reason: string): Promise<void> {
    this.stoppingSession = true;
    this.denyApprovals();
    try {
      for (const control of this.agentPending.keys()) control.abort(new KodoError('TURN_INTERRUPTED', reason));
      for (const control of this.checks) control.abort(new KodoError('TURN_INTERRUPTED', reason));
      const owners = this.ownedRuns();
      for (const run of owners) if (!terminal(run.status) && run.status !== 'interrupted') this.options.app.coordinator.interrupt(run.id);
      await Promise.all(owners.map(run => this.options.app.coordinator.waitForStop(run.id)));
      await Promise.all(owners.map(run => this.options.app.coordinator.tools.stopBackground(run.id, reason, false)));
      await Promise.allSettled([...this.running.values(), ...this.agentPending.values()]);
      if (this.ownedRuns().some(run => this.options.app.coordinator.tools.backgroundRunning(run.id) || this.options.app.coordinator.tools.hasInFlightEffects(run.id))) throw new KodoError('TUI_SETTLING', 'Background processes or host writes are still settling. Wait for their records, then retry stop or exit.');
    } finally { this.stoppingSession = false; this.notify(true); }
  }
  private async drainQueue(): Promise<void> {
    if (this.draining) return await this.draining;
    const draining = this.drainNext(); this.draining = draining;
    try { await draining; } finally { this.draining = undefined; this.notify(); }
  }
  private async drainNext(): Promise<void> {
    if (this.closed || this.quitting || this.exiting || this.hasActive()) return;
    const item = this.queue.shift();
    if (!item) return;
    try { const source = this.requireRun(); await this.ensureRestored(source); if (this.exiting || this.closed) { this.queue.unshift(item); return; } const run = this.options.app.submitInput(source.id, item.content, { mode: 'follow_up' }); this.currentId = run.id; this.historyIds.add(run.id); this.restored.add(run.sessionId); this.wake(run.id); }
    catch (error) { this.queue.unshift(item); this.notice = this.clean(errorText(error)); this.notify(true); }
  }
  private async next(args: string[]): Promise<void> {
    if (!args.length || args[0] === 'list') { this.panel = { title: 'Follow-up queue', lines: ['Queued tasks can be edited or removed before they start.', ...this.queue.map((item, index) => `${index + 1}. ${item.id} · ${this.clean(item.content)}`)], items: this.queue.flatMap(item => [
      { id: `edit:${item.id}`, label: `Edit ${short(item.content, 40)}`, input: `/next edit ${item.id} ${quoteArgument(item.content)}` },
      { id: `remove:${item.id}`, label: `Remove ${short(item.content, 40)}`, command: `/next remove ${item.id}` },
    ]) }; return; }
    if (args[0] === 'remove' || args[0] === 'edit') {
      const index = this.queue.findIndex(item => item.id === args[1]);
      if (index < 0) throw new KodoError('TUI_QUEUE', 'Queued task not found.');
      if (args[0] === 'remove') this.queue.splice(index, 1);
      else { const content = args.slice(2).join(' '); if (!content.trim()) throw new KodoError('TUI_QUEUE', 'A queued task cannot be empty.'); this.queue[index]!.content = content; }
      this.notice = 'Follow-up queue updated.'; await this.next([]); return;
    }
    this.requireRun(); const content = args.join(' ');
    if (content.length > 16_000 || this.queue.length >= 100) throw new KodoError('TUI_QUEUE', 'The queue allows 100 tasks of up to 16000 characters each.');
    this.queue.push({ id: randomUUID().slice(0, 8), content }); this.notice = 'Task queued. Use /next to view, edit or remove it.';
    if (!this.hasActive()) await this.drainQueue();
  }

  private async resume(args: string[]): Promise<void> {
    if (!args.length || args[0] === 'list') {
      let after = Number(args[1] ?? 0); if (!Number.isSafeInteger(after) || after < 0) throw new KodoError('TUI_CURSOR', 'The session cursor must be a nonnegative integer.');
      const matches: Run[] = []; let next: number | null;
      do {
        const page = this.options.app.runs({ after, limit: 100 - matches.length });
        matches.push(...page.items.filter(run => !run.parentId && this.options.app.store.session(run.sessionId).workspace === this.options.workspace));
        next = page.next;
        if (next !== null) after = next;
      } while (next !== null && matches.length < 100);
      this.panel = { title: 'Session history and recovery', lines: ['Opening a session only displays saved records. Resuming execution requires confirmation.'], items: [...matches.reverse().map(run => ({ id: run.id, label: `${statusLabel[run.status]} · ${short(run.objective, 70)}`, detail: run.id, command: `/resume ${run.id}` })), ...(next === null ? [] : [{ id: 'next', label: 'Next sessions', command: `/resume list ${next}` }])] }; return;
    }
    const execute = args[0] === 'run', id = execute ? args[1] : args[0];
    if (!id) throw new KodoError('TUI_RESUME', 'Select a main task.');
    if (this.hasActive() && id !== this.currentId) throw new KodoError('TUI_ACTIVE', 'Stop the current session before opening another one.');
    const run = this.options.app.store.run(id);
    if (run.parentId || this.options.app.store.session(run.sessionId).workspace !== this.options.workspace) throw new KodoError('TUI_RESUME', 'Only main tasks in the current workspace can be opened.');
    const recoverFailed = run.status === 'failed' && run.error?.startsWith('UNKNOWN_WRITE:') === true;
    const resumable = !terminal(run.status) || recoverFailed;
    this.select(run);
    if (!execute) {
      this.panel = { title: 'Session opened', lines: [`${statusLabel[run.status]} · ${run.objective}`, 'Saved state loaded. No tool or model request was replayed.', ...(recoverFailed ? ['Review unknown writes with /tasks resolve first. Recovery creates a continuation and retains the failed record.'] : [])], items: resumable ? [{ id: 'resume', label: recoverFailed ? 'Review and resume as a continuation' : 'Resume execution', command: `/resume run ${run.id}` }] : [{ id: 'follow', label: 'Continue as a new task', input: '' }], hint: resumable ? 'Review unknown writes and local capability bindings before resuming. Unapproved writes are not retried.' : 'Send a new task to create a continuation; the original terminal record is retained.' }; return;
    }
    if (!resumable) throw new KodoError('RUN_ENDED', 'An ended task cannot be reopened. Send text to continue as a new task.');
    await this.ensureRestored(run);
    if (recoverFailed) {
      const blocked = this.options.app.coordinator.recovery.plan(run.id).blocked;
      if (blocked.length) throw new KodoError('UNKNOWN_WRITE', `There are ${blocked.length} writes awaiting review; use /tasks resolve ${blocked[0]} with observed results and evidence before resuming. Execution has not been replayed.`);
    }
    if (run.status === 'interrupted' || recoverFailed) {
      if (run.status === 'interrupted' && run.interruptRequested) this.options.app.coordinator.resumeInterrupted(run.id);
      else {
        if (!this.running.has(run.id)) {
          const work = Promise.resolve().then(async () => { await this.options.beforeRun?.(run.id); const recovered = await this.options.app.recover(run.id); this.select(recovered); this.restored.add(recovered.sessionId); })
            .catch(error => { this.notice = this.clean(errorText(error)); })
            .finally(() => { this.running.delete(run.id); this.notify(true); });
          this.running.set(run.id, work);
        }
        this.panel = undefined; this.notice = 'Reviewing and recovering with the original host bindings.'; return;
      }
    }
    this.panel = undefined; this.wake(this.currentId!);
  }
  private async model(args: string[]): Promise<void> {
    this.cancelModelQuery();
    const config = this.options.modelConfig;
    if (!config) {
      if (args.length) {
        const model = args.join(' ').trim(); this.validateModel(model);
        this.binding = { ...this.binding, model }; this.notice = 'Model selected for new sessions. Use /new to start with it. Existing runs keep their original binding.';
      }
      this.panel = { title: 'Model for new sessions', lines: [...this.modelBindingLines(), `Protocol: ${this.binding.protocol ?? 'chat-completions'}`, 'Use /model name to select a model. See /settings for connection and credential variables.'], items: [{ id: 'model', label: 'Enter model name', input: '/model ' }] };
      return;
    }
    let provider = this.modelProvider;
    if (args[0] === 'all' && args.length === 1) provider = '*';
    else if (args[0] === 'provider' && args.length > 1) {
      if (args.length !== 2) throw new KodoError('TUI_MODEL', 'Use /model provider provider-id.');
      provider = args[1]; this.validateProvider(provider);
    } else if (args.length) {
      let model: string;
      if (args[0] === 'select' && args.length > 1) {
        if (args.length !== 3) throw new KodoError('TUI_MODEL', 'Use /model select provider-id model-id.');
        provider = args[1] === '-' ? undefined : args[1]; this.validateProvider(provider);
        model = args[2]!;
      } else model = args.join(' ').trim();
      this.validateModel(model);
      const selected = await config.select(provider, model);
      this.binding = { ...selected }; this.modelProvider = provider;
      this.notice = 'Model saved for new sessions. Use /new to start with it. Existing runs keep their original binding.';
      this.panel = this.modelPanel(provider, ['Selection saved. Use /model to refresh available models.']);
      return;
    }
    const control = new AbortController();
    this.modelQuery = control;
    this.panel = this.modelPanel(provider, ['Loading models…']);
    this.modelLoadingPanel = this.panel;
    // Metadata loading must not occupy the submission queue or delay exit and approvals.
    void Promise.resolve().then(() => config.listModels(provider, control.signal)).then(models => {
      if (this.modelQuery !== control || control.signal.aborted || this.closed) return;
      this.modelQuery = undefined; this.modelLoadingPanel = undefined;
      this.panel = this.modelPanel(provider, [...(models.length ? [] : ['No models returned. Enter an exact model ID manually or configure another provider with kodo config.']), ...(config.lastModelWarnings ?? []).map(warning => `Warning: ${warning}`)], models);
      this.notify(true);
    }, error => {
      if (this.modelQuery !== control || control.signal.aborted || this.closed) return;
      this.modelQuery = undefined; this.modelLoadingPanel = undefined;
      this.panel = this.modelPanel(provider, [`Could not load models: ${this.clean(errorText(error))}`, 'Check the provider with kodo config, retry /model, or enter an exact model ID manually.']);
      this.notify(true);
    });
  }

  private validateModel(model: string): void {
    if (!model.trim() || model.length > 512 || /[\p{Cc}\p{Cf}]/u.test(model)) throw new KodoError('TUI_MODEL', 'Invalid model name.');
  }

  private validateProvider(provider: string | undefined): void {
    if (provider !== undefined && !this.options.modelConfig?.providers.some(item => item.id === provider)) throw new KodoError('TUI_MODEL', `Unknown provider ${provider}. Configure it with kodo config.`);
  }

  private modelBindingLines(): string[] {
    return [`New session model: ${this.binding.model || 'Not configured'}`, ...(this.current() ? [`Current run model: ${this.current()!.binding.model} (fixed; use /new for the selected model)`] : [])];
  }

  private modelPanel(provider: string | undefined, lines: string[], models: { id: string; name?: string; provider?: string; sources?: string[] }[] = []): TuiPanel {
    const selection = `/model select ${quoteArgument(provider ?? '-')} `;
    const group = this.options.modelConfig?.providers.find(item => item.id === provider && item.members);
    return { title: `Models · ${provider === '*' ? 'all providers' : provider ?? 'current connection'}`, lines: [...this.modelBindingLines(), ...(group ? [`Sources: ${group.members!.join(', ')}`] : []), ...lines], items: [
      ...models.map((model, index) => {
        const target = provider === '*' ? model.provider : provider;
        const selectable = provider !== '*' || Boolean(target && target !== '*' && this.options.modelConfig?.providers.some(item => item.id === target && !item.members));
        const provenance = model.sources?.length ? `Sources: ${model.sources.join(', ')}` : model.provider ? `Provider: ${model.provider}` : '';
        const detail = [model.name && model.name !== model.id ? model.name : '', provenance].filter(Boolean).join(' · ');
        return { id: provider === '*' ? `model:${model.provider ?? 'unknown'}:${model.id}:${index}` : `model:${model.id}`, label: provider === '*' ? `${model.id} · ${model.provider ?? 'source unavailable'}` : model.id,
          ...(detail ? { detail } : {}), ...(selectable ? { command: `/model select ${quoteArgument(target ?? '-')} ${quoteArgument(model.id)}` } : { disabled: true }) };
      }),
      { id: 'all', label: 'Browse models from all providers', command: '/model all' },
      ...(this.options.modelConfig?.providers ?? []).map(item => ({ id: `provider:${item.id}`, label: `${item.members ? 'Group' : 'Provider'}: ${item.id}${item.id === this.modelProvider ? ' (selected)' : ''}`, detail: item.members ? `Sources: ${item.members.join(', ')}` : item.model, command: `/model provider ${quoteArgument(item.id)}` })),
      ...(provider === '*' ? [{ id: 'providers', label: 'Choose a provider for manual model entry', command: '/providers' }] : [{ id: 'manual', label: 'Enter model ID manually', input: selection }]),
    ], hint: 'Type to filter. Enter to select. Esc to return. /providers manages connections and groups.' };
  }

  private async providers(args: string[]): Promise<void> {
    const config = this.options.modelConfig;
    if (!config) {
      if (args.length) throw new KodoError('TUI_PROVIDERS', 'Configure providers with kodo config before selecting or merging them.');
      this.panel = { title: 'Providers', lines: ['Configure providers with kodo config. Use /model to enter a model for the current connection.'], items: [{ id: 'model', label: 'Select a model', command: '/model' }] }; return;
    }
    if (args[0] === 'merge') {
      if (!config.mergeProviders) throw new KodoError('TUI_PROVIDERS', 'This host does not support provider groups. Configure providers with kodo config.');
      if (args.length < 4) throw new KodoError('TUI_PROVIDERS', 'Use /providers merge group-name provider-a provider-b.');
      const [, name, ...members] = args;
      await config.mergeProviders(name!, members);
      this.notice = `Provider group ${name} saved. Select it to use it for new sessions.`;
      this.panel = this.providersPanel(); return;
    }
    if (args.length) {
      const id = args[0] === 'select' ? args[1] : args[0];
      if (!id || args.length !== (args[0] === 'select' ? 2 : 1)) throw new KodoError('TUI_PROVIDERS', 'Use /providers, /providers select provider-id or /providers merge group-name provider-a provider-b.');
      this.validateProvider(id);
      if (!config.selectProvider) { await this.model(['provider', id]); return; }
      const binding = await config.selectProvider(id);
      this.binding = { ...binding }; this.modelProvider = id;
      this.notice = `Provider saved for new sessions.${binding.model ? '' : ' Choose a model first.'} Use /new to start with it. Existing runs keep their original binding.`;
      if (!binding.model.trim()) { await this.model(['provider', id]); return; }
    }
    this.panel = this.providersPanel();
  }

  private providersPanel(): TuiPanel {
    const config = this.options.modelConfig!;
    const selected = config.providers.find(item => item.id === this.modelProvider);
    return { title: 'Providers', lines: [
      `New sessions: ${selected?.members ? 'group ' : ''}${this.modelProvider ?? 'current connection'} · ${this.binding.model || 'Select a model'}`,
      ...(this.current() ? [`Current run model: ${this.current()!.binding.model} (fixed; use /new after switching)`] : []),
      ...(config.providers.length ? [] : ['No providers configured. Run kodo config to add one.']),
      ...(config.mergeProviders ? ['Merge example: /providers merge shared provider-a provider-b. Sources are tried in the listed order.'] : []),
    ], items: [
      ...config.providers.map(item => ({ id: `provider:${item.id}`, label: `${item.members ? 'Group' : 'Provider'}: ${item.id}${item.id === this.modelProvider ? ' (selected)' : ''}`, detail: [item.model ? `Model: ${item.model}` : 'Choose a model', ...(item.members ? [`Sources: ${item.members.join(', ')}`] : [])].join(' · '), command: `/providers select ${quoteArgument(item.id)}` })),
      { id: 'all', label: 'Browse models from all providers', command: '/model all' },
      ...(config.mergeProviders ? [{ id: 'merge', label: 'Merge provider catalogues into a group', input: '/providers merge ' }] : []),
    ], hint: 'Type to filter. Enter to select. Esc to return. Selections apply to new sessions.' };
  }

  private cancelModelQuery(): void {
    const query = this.modelQuery;
    this.modelQuery = undefined;
    if (this.panel === this.modelLoadingPanel) this.panel = undefined;
    this.modelLoadingPanel = undefined;
    query?.abort(new KodoError('CANCELLED', 'Model listing cancelled.'));
  }
  private async requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    if (this.closed || this.exiting || this.quitting || this.stoppingSession || signal.aborted) return false;
    if (this.permissionMode === 'yolo') return true;
    const id = randomUUID();
    return await new Promise<boolean>(resolve => {
      const settle = (allowed: boolean): void => {
        if (!this.approvals.delete(id)) return;
        signal.removeEventListener('abort', abort);
        resolve(allowed);
        this.notify(true);
      };
      const abort = (): void => settle(false);
      this.approvals.set(id, { request, settle });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      this.notify(true);
    });
  }

  private denyApprovals(runId?: string): void {
    for (const pending of [...this.approvals.values()]) if (!runId || pending.request.runId === runId) pending.settle(false);
  }

  private permissions(args: string[]): void {
    const [action, id] = args;
    if (!action) { this.permissionMenu = true; this.panel = undefined; return; }
    if ((action === 'ask' || action === 'yolo') && args.length === 1) {
      this.permissionMode = action; this.permissionMenu = false; this.panel = undefined;
      this.notice = action === 'ask' ? 'Ask mode: file changes, commands and network tool calls require approval.' : 'YOLO mode: pending and future permitted tool calls run automatically.';
      if (action === 'yolo') for (const pending of [...this.approvals.values()]) pending.settle(true);
      return;
    }
    if ((action === 'approve' || action === 'deny') && id && args.length === 2) {
      const pending = this.approvals.get(id);
      if (!pending) throw new KodoError('TUI_PERMISSION_REQUEST', 'This approval request has expired or was already answered.');
      this.permissionMenu = false;
      pending.settle(action === 'approve');
      this.notice = action === 'approve' ? 'Approved this tool call once.' : 'Denied this tool call. No operation was authorized.';
      return;
    }
    throw new KodoError('TUI_PERMISSIONS', 'Use /permissions, /permissions ask or /permissions yolo.');
  }

  private permissionsPanel(): TuiPanel {
    const first = this.approvals.entries().next().value;
    const run = this.current();
    const session = run ? this.options.app.store.session(run.sessionId) : undefined;
    const grants = (session?.permissions ?? this.options.permissions).filter(permission => !run?.permissions || run.permissions.includes(permission));
    if (first && !this.permissionMenu) {
      const [id, pending] = first;
      const owner = this.options.app.store.run(pending.request.runId);
      return { title: 'Approval required', lines: [
        `${pending.request.name} · ${owner.card.name}`, `Workspace: ${this.options.app.store.session(owner.sessionId).workspace}`,
        ...jsonLines(pending.request.arguments), ...(this.approvals.size > 1 ? [`${this.approvals.size} requests waiting. Each approval applies to one tool call.`] : []),
      ], items: [
        { id: 'deny', label: 'Deny', command: `/permissions deny ${id}` },
        { id: 'approve', label: 'Allow once', command: `/permissions approve ${id}` },
        { id: 'modes', label: 'Change permission mode', command: '/permissions' },
      ], hint: 'Enter to select. Esc denies this request. Ctrl+C interrupts.' };
    }
    return { title: 'Permissions', lines: [
      `Current mode: ${this.permissionMode === 'ask' ? 'Ask' : 'YOLO'}`, `Tool grants: ${grants.join(', ') || 'none'}`,
      'Ask: review file changes, commands and network tool calls.',
      'YOLO: automatically approve pending and future permitted tool calls.',
      'Workspace rules, tool grants and host sandbox settings still apply.',
      ...(this.approvals.size ? [`${this.approvals.size} approval requests waiting. Esc returns to the request.`] : []),
    ], items: [
      { id: 'ask', label: `Ask${this.permissionMode === 'ask' ? ' (current)' : ''}`, detail: 'Review each action before it runs', command: '/permissions ask' },
      { id: 'yolo', label: `YOLO${this.permissionMode === 'yolo' ? ' (current)' : ''}`, detail: 'Run permitted actions automatically', command: '/permissions yolo' },
    ], hint: 'Enter to select. Esc to return. Mode resets to Ask when Kodo restarts.' };
  }

  private settings(args: string[]): void {
    if (args.length) throw new KodoError('TUI_SETTINGS', 'Use kodo config to configure providers, /model to select a model, or /permissions to change approval mode.');
    if (this.options.modelConfig) {
      const config = this.options.modelConfig;
      const group = config.providers.find(item => item.id === this.modelProvider)?.members;
      this.panel = { title: 'Host settings', lines: [
        `Workspace: ${this.options.workspace}`, `User config: ${config.path}`,
        `Provider: ${this.modelProvider ?? 'current connection'}${group ? ' (group)' : ''}`, `Model: ${this.binding.model || 'Not configured'} (new sessions)`,
        `Credentials: ${process.env[this.binding.apiKeyEnv] ? 'Configured' : 'Not configured'}`, `Approval mode: ${this.permissionMode === 'ask' ? 'Ask' : 'YOLO'}`,
        'Use /providers for connections and groups, /model for models, and kodo config for credentials.',
      ], items: [{ id: 'providers', label: 'Select provider or group', command: '/providers' }, { id: 'models', label: 'Select a model', command: '/model' }, { id: 'permissions', label: 'Configure permissions', command: '/permissions' }] };
      return;
    }
    this.panel = { title: 'Host settings', lines: [
      `Workspace: ${this.options.workspace}`, `Model: ${this.binding.model || 'Not configured'} (new sessions)`, `Protocol: ${this.binding.protocol ?? 'chat-completions'}`,
      `Credential environment variable: ${this.binding.apiKeyEnv} ${process.env[this.binding.apiKeyEnv] ? 'Configured' : 'Not configured'}`,
      `Permissions: ${this.options.permissions.join(', ')}`, `Approval mode: ${this.permissionMode === 'ask' ? 'Ask' : 'YOLO'} (/permissions)`, 'Tool grants, sandbox, capabilities, verification and budgets come from the host.',
      'Connection: --model --base-url --api-key-env --protocol. Store keys in local environment variables.',
      'Execution: --allow-write --allow-exec --sandbox. Verification: --verification-config or --verify-command.',
      'Restart to change host capabilities. /model only changes new sessions.',
    ], items: [{ id: 'providers', label: 'Select provider or group', command: '/providers' }, { id: 'models', label: 'Select a model', command: '/model' }, { id: 'permissions', label: 'Configure permissions', command: '/permissions' }] };
  }

  private current(): Run | undefined { return this.currentId ? this.options.app.store.run(this.currentId) : undefined; }
  private requireRun(): Run { const run = this.current(); if (!run) throw new KodoError('TUI_RUN', 'No task yet. Send a task or open history with /resume.'); return run; }
  private ownedRuns(): Run[] { const run = this.current(); return run ? this.options.app.store.listRuns(run.sessionId) : []; }
  private familyRuns(): Run[] { return this.ownedRuns().filter(run => this.historyIds.has(run.id) || Boolean(run.parentId && this.historyIds.has(run.parentId))); }
  private hasActive(ignoreAgentOperation = false): boolean { return this.stoppingSession || Boolean(this.starting) || Boolean(this.draining) || (!ignoreAgentOperation && this.agentPending.size > 0) || this.checks.size > 0 || this.ownedRuns().some(run => (!terminal(run.status) && run.status !== 'interrupted') || this.options.app.coordinator.tools.backgroundRunning(run.id) || this.options.app.coordinator.tools.hasInFlightEffects(run.id)); }
  private async ensureRestored(run: Run): Promise<void> {
    if (this.restored.has(run.sessionId)) return;
    if (!this.options.restore) throw new KodoError('TUI_RESTORE', 'This session needs its original host configuration. Restore it through the original CLI settings.');
    await this.options.restore(run); this.restored.add(run.sessionId);
  }

  private select(run: Run): void {
    this.currentId = run.id; this.entries.clear(); this.processes.clear(); this.answerTarget = undefined; this.cursor = 0;
    this.historyIds.clear(); let source = run;
    while (!this.historyIds.has(source.id)) {
      this.historyIds.add(source.id);
      const previous = source.historyFrom ?? source.continuationOf;
      if (!previous) break;
      const owner = this.options.app.store.run(previous);
      if (owner.sessionId !== run.sessionId || owner.parentId) break;
      source = owner;
    }
    this.put({ id: `objective:${source.id}`, kind: 'user', title: 'Task', text: this.clean(source.objective) });
    // Read durable history in pages; only the bounded visible projection is retained.
    const end = Math.max(0, ...this.ownedRuns().map(peer => this.options.app.store.latestEventSeq(peer.id)));
    let after = 0;
    for (;;) {
      const page = this.options.app.events({ sessionId: run.sessionId, after, limit: 250 });
      for (const event of page.items) this.consume(event);
      if (page.next === null || page.next >= end) break;
      after = page.next;
    }
    this.cursor = Math.max(this.cursor, end);
    // The final result is authoritative even when its event was outside the tail.
    if (run.resultRef) this.resultEntry(run);
    if (this.entries.size >= entryLimit) this.notice = 'Showing the latest 300 entries. Use /tasks history for saved pages.';
  }

  private resultEntry(run: Run): void {
    if (!run.resultRef) return;
    const result = this.options.app.store.readBlob<{ text?: string; quality?: { status?: string }; reportCompleteness?: { status?: string }; parentJudgment?: { status?: string } }>(run.resultRef);
    this.entries.delete(`stream:${run.id}`);
    const stale = (run.decisionVersion ?? 0) < (this.options.app.store.session(run.sessionId).decisionVersion ?? 0);
    this.put({ id: `result:${run.id}`, kind: 'assistant', title: 'Kodo · Delivery', text: this.clean(result.text ?? 'This task has no text deliverable.'), status: `${statusLabel[run.status]} · Host verification ${result.quality?.status ?? 'not_checked'}${stale ? ' · Decision changed; review required' : ''}`, details: [
      `Run: ${statusLabel[run.status]}`, `Host verification: ${result.quality?.status ?? 'not_checked'}`,
      `Report completeness: ${result.reportCompleteness?.status ?? 'not_required'}`, `Main agent judgment: ${result.parentJudgment?.status ?? 'not_checked'}`,
      'Changes: /changes. Verification: /check results. Completion alone does not mean verification passed.',
    ] });
  }

  private consume(event: RuntimeEvent): void {
    this.cursor = Math.max(this.cursor, event.seq);
    const main = this.current(); if (!main) return;
    const isMain = event.runId === main.id;
    const data = event.data;
    if (event.type === 'run.queued' && data.continuationOf === main.id && !this.options.app.store.run(event.runId).parentId) this.historyIds.add(event.runId);
    if (isMain && event.type === 'recovery.continued' && typeof data.runId === 'string') { const replacement = this.options.app.store.run(data.runId); this.restored.add(replacement.sessionId); this.select(replacement); return; }
    if (event.type === 'model.provider_changed') {
      const owner = this.options.app.store.run(event.runId);
      if (this.historyIds.has(owner.id) || owner.parentId && this.historyIds.has(owner.parentId)) this.put({ id: `provider:${event.seq}`, kind: 'notice', title: 'Provider changed',
        text: `${owner.parentId ? owner.card.name : 'Main task'}: ${short(String(data.from ?? 'unknown'), 64)} → ${short(String(data.to ?? 'unknown'), 64)} · ${short(String(data.model ?? owner.binding.model), 100)} · ${short(String(data.reason ?? 'Connection changed'), 120)} · Cost change unknown` });
      return;
    }
    if (event.type === 'message.created' && typeof data.messageId === 'string') {
      const message = this.options.app.store.message(data.messageId);
      if (message?.from === 'user' && this.historyIds.has(message.to) && ['input', 'decision', 'answer'].includes(message.kind)) {
        this.put({ id: `message:${message.id}`, kind: 'user', title: message.kind === 'decision' ? 'Decision update' : 'You', text: this.clean(message.content) });
      }
      return;
    }
    if (event.type === 'tool.finished' && typeof data.callId === 'string') {
      const call = this.options.app.store.call(data.callId);
      if (call.name === 'process.exec' && call.resultRef) {
        const result = this.options.app.store.readBlob<{ background?: { id: string; state?: string } }>(call.resultRef);
        if (result.background) this.processes.set(result.background.id, { id: result.background.id, kind: 'process', runId: event.runId, label: 'Background process', status: result.background.state ?? call.status, detail: `Owner task ${event.runId}`, command: `/tasks process ${result.background.id}` });
      }
    }
    if (event.type === 'process.background.finished' && typeof data.id === 'string') {
      const existing = this.processes.get(data.id);
      this.processes.set(data.id, { ...existing, id: data.id, kind: 'process', runId: event.runId, label: 'Background process', status: String(data.state ?? data.status ?? 'Ended'), detail: `Exit code ${String(data.exitCode ?? 'unknown')} · Owner task ${event.runId}`, command: `/tasks process ${data.id}` });
    }
    if (!this.historyIds.has(event.runId)) return;
    if (event.type === 'tool.started' && typeof data.callId === 'string') this.put({ id: `tool:${data.callId}`, kind: 'tool', title: String(data.name), text: 'Executing', status: 'Running' });
    if (event.type === 'tool.finished' && typeof data.callId === 'string') {
      const call = this.options.app.store.call(data.callId);
      const result = call.resultRef ? this.options.app.store.readBlob<{ exitCode?: number | null; cancelled?: boolean; outputLimitExceeded?: boolean; passed?: boolean } | null>(call.resultRef) : undefined;
      const failed = typeof result?.exitCode === 'number' && result.exitCode !== 0 || result?.cancelled === true || result?.outputLimitExceeded === true || result?.passed === false;
      const facts = [`Call record: ${call.status}`, ...(result?.exitCode !== undefined ? [`Exit code ${String(result.exitCode ?? 'unknown')}`] : []), ...(result?.cancelled ? ['Process cancelled'] : []), ...(result?.outputLimitExceeded ? ['Output limit exceeded; result incomplete'] : []), ...(typeof result?.passed === 'boolean' ? [result.passed ? 'Tool check passed' : 'Tool check failed'] : [])];
      this.put({ id: `tool:${call.id}`, kind: 'tool', title: call.name, text: `${call.status === 'unknown' ? 'Effects need review. Open /tasks resolve.\n' : ''}${facts.join(' · ')}`, status: call.status === 'unknown' ? 'unknown' : failed || call.status === 'failed' ? 'Failed' : call.status, details: [`Call ${call.id}`, `Step ${call.step}`, `Evidence: /tasks evidence ${call.runId} ${call.id}`] });
    }
    if (event.type === 'run.completed') this.resultEntry(this.options.app.store.run(event.runId));
    if (['run.failed', 'run.cancelled', 'run.interrupted'].includes(event.type)) {
      const run = this.options.app.store.run(event.runId);
      const stream = this.entries.get(`stream:${run.id}`); if (stream) this.put({ ...stream, status: 'Incomplete output' });
      this.put({ id: `state:${event.seq}`, kind: run.status === 'failed' ? 'error' : 'notice', text: this.clean(`${statusLabel[run.status]}${run.error ? `: ${run.error}` : ''}`) });
    }
    if (event.type === 'files.changed' || event.type === 'file.rewind.completed') this.put({ id: `changes:${event.seq}`, kind: 'notice', title: 'Workspace changes', text: this.clean(Array.isArray(data.paths) ? data.paths.join(', ') : 'See /changes') });
    if (event.type === 'completion.checked') this.put({ id: `check:${event.seq}`, kind: 'notice', title: 'Host completion check', text: `Delivery ${String(data.deliveryPassed)} · Quality ${String(data.qualityPassed ?? 'not_checked')}${data.reportPassed === undefined ? '' : ` · Report ${String(data.reportPassed)}`}`, details: typeof data.evidenceRef === 'string' ? [`Evidence ${data.evidenceRef}`] : [] });
    if (event.type === 'decision.updated') { this.put({ id: `decision:${event.seq}`, kind: 'notice', title: 'Decision updated', text: this.clean(String(data.content ?? '')), status: `Version ${String(data.version)}` }); for (const owner of this.familyRuns()) if (owner.resultRef && this.entries.has(`result:${owner.id}`)) this.resultEntry(owner); }
  }

  private put(entry: TuiEntry): void {
    this.entries.set(entry.id, { ...entry, text: this.clean(entry.text).slice(0, textLimit), ...(entry.title ? { title: this.clean(entry.title) } : {}), ...(entry.details ? { details: entry.details.map(line => this.clean(line).slice(0, textLimit)) } : {}) });
    while (this.entries.size > entryLimit) this.entries.delete(this.entries.keys().next().value!);
  }
  private clean(text: string): string {
    for (const key of new Set([this.binding.apiKeyEnv, this.current()?.binding.apiKeyEnv].filter((key): key is string => Boolean(key)))) {
      const secret = process.env[key]; if (secret) text = text.replaceAll(secret, '[REDACTED]');
    }
    return terminalText(text);
  }
  private notify(immediate = false): void {
    if (this.closed) return;
    if (immediate) { if (this.timer) clearTimeout(this.timer); this.timer = undefined; for (const listener of this.listeners) listener(); }
    else if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.notify(true); }, 40);
  }
  private statusPanel(): TuiPanel {
    const run = this.current();
    if (!run) return { title: 'Session overview', lines: ['No task created yet.', `Workspace: ${this.options.workspace}`, `Model: ${this.binding.model || 'Not configured'}`, 'Send a task to begin. Local views do not call the model.'] };
    const session = this.options.app.store.session(run.sessionId);
    return { title: 'Session overview', lines: [
      `Main task: ${run.id}`, `Session: ${session.id}`, `Objective: ${this.clean(run.objective)}`, `Run: ${statusLabel[run.status]}`,
      `Agent: ${run.card.id}@${run.card.version}`, `Model: ${run.binding.model}`, `Decision version: ${session.decisionVersion ?? 0}`,
      `Model requests ${session.modelCalls} · Tool calls ${session.toolCalls} · Questions ${this.options.app.coordinator.mailbox.userQuestions(session.id).length}`,
      this.snapshot().usage,
    ] };
  }

  private target(id?: string): Run {
    const main = this.requireRun(); const target = id ? this.options.app.store.run(id) : main;
    if (target.sessionId !== main.sessionId || !this.familyRuns().some(run => run.id === target.id)) throw new KodoError('TUI_TARGET', 'Select a task from the current main task history or its managed children.');
    return target;
  }
  private async tasks(args: string[]): Promise<void> {
    const [action, id, ...rest] = args;
    const main = this.requireRun();
    if (!action || action === 'panel' || action === 'list') {
      const snapshot = this.snapshot();
      const unknown = this.familyRuns().flatMap(run => this.options.app.store.queryCalls(run.id, { kind: 'tool', status: 'unknown', limit: 100 }));
      this.panel = { title: 'Tasks and agents', lines: ['The composer always addresses the main agent. Browsing a child does not change the recipient.', 'Agents and processes have separate controls. Run, verification and report states are independent.'], items: [
        { id: 'history', label: 'Browse saved history', command: '/tasks history' },
        ...snapshot.tasks.map(task => ({ id: task.id, label: `${task.kind === 'process' ? 'Process' : 'Task'} · ${task.label} · ${task.status}`, detail: task.detail, command: task.command })),
        ...snapshot.questions.map(question => ({ id: question.id, label: `Question: ${short(question.content, 80)}`, command: `/tasks answer ${question.id}` })),
        ...unknown.map(call => ({ id: call.id, label: `Effects need review: ${call.name}`, command: `/tasks resolve ${call.id}` })),
      ] }; return;
    }
    if (action === 'history') {
      const after = Number(id ?? 0); if (!Number.isSafeInteger(after) || after < 0) throw new KodoError('TUI_CURSOR', 'The history cursor must be a nonnegative integer.');
      const page = this.options.app.events({ sessionId: main.sessionId, after, limit: 50 }), owners = new Set(this.familyRuns().map(run => run.id));
      const visible = page.items.filter(event => owners.has(event.runId));
      this.panel = { title: 'Saved history · Page', lines: ['Up to 50 events per page. Open evidence for long tool output.', ...visible.map(event => `${event.seq} · ${event.time} · ${event.runId} · ${event.type}${event.data.name ? ` · ${String(event.data.name)}` : ''}`)], items: [
        ...visible.flatMap(event => event.type === 'tool.finished' && typeof event.data.callId === 'string' ? [{ id: String(event.seq), label: `Read tool evidence: ${String(event.data.name ?? event.data.callId)}`, command: `/tasks evidence ${event.runId} ${event.data.callId}` }] : event.type === 'run.completed' ? [{ id: String(event.seq), label: `Read original delivery: ${event.runId}`, command: `/tasks result ${event.runId}` }] : event.type === 'message.created' && typeof event.data.messageId === 'string' && this.options.app.store.message(event.data.messageId)?.from === 'user' ? [{ id: String(event.seq), label: 'Read original user input', command: `/tasks input ${event.data.messageId}` }] : []),
        ...(page.next === null ? [] : [{ id: 'next', label: 'Next history page', command: `/tasks history ${page.next}` }]),
      ] }; return;
    }
    if (action === 'input') {
      const message = id ? this.options.app.store.message(id) : undefined;
      if (!message || message.from !== 'user' || !this.familyRuns().some(run => run.id === message.to)) throw new KodoError('TUI_INPUT', 'Select user input from this task history.');
      this.panel = { title: 'Saved user input', lines: [this.clean(message.content)], hint: `Recipient task ${message.to}` }; return;
    }
    if (action === 'process' || action === 'process-stop') {
      const process = id ? this.processes.get(id) : undefined;
      if (!process) throw new KodoError('TUI_PROCESS', 'Background process record not found.');
      if (action === 'process-stop') {
        if (rest[0] !== 'confirm') { this.panel = { title: 'Stop background processes for the owner task', lines: [`Owner task ${process.runId}`, 'Stopping affects all background processes owned by this task. File changes are retained.'], items: [{ id: 'confirm', label: 'Stop all background processes for this task', command: `/tasks process-stop ${process.id} confirm` }] }; return; }
        await this.options.app.coordinator.tools.stopBackground(process.runId, 'user requested process stop', false); this.notice = 'Background process stop completed. Review process evidence.'; return;
      }
      const output = await this.options.app.coordinator.tools.execute(process.runId, 'process.read', { id: process.id, stdoutOffset: Number(rest[0] ?? 0), stderrOffset: Number(rest[1] ?? 0), maxChars: 8000, waitMs: 0 }, new AbortController().signal) as Record<string, unknown>;
      const running = output.state === 'running';
      this.panel = { title: 'Background process · Untrusted output', lines: jsonLines(output).map(line => this.clean(line)), items: [
        { id: 'more', label: 'Read next page / refresh', command: `/tasks process ${process.id} ${String(output.stdoutOffset ?? 0)} ${String(output.stderrOffset ?? 0)}` },
        ...(running ? [{ id: 'stop', label: 'Stop owner background processes...', command: `/tasks process-stop ${process.id}` }] : []),
      ] }; return;
    }
    if (action === 'answer') {
      const questions = this.options.app.coordinator.mailbox.userQuestions(main.sessionId);
      if (!id) { this.panel = { title: 'Select a question', lines: questions.length ? ['Choose a question, then enter an answer.'] : ['No pending questions.'], items: questions.map(question => ({ id: question.id, label: short(this.clean(question.content), 100), command: `/tasks answer ${question.id}` })) }; return; }
      const question = questions.find(question => question.id === id);
      if (!question) throw new KodoError('QUESTION', 'Select a pending question in the current session.');
      if (rest.length) { await this.ensureRestored(main); const run = this.options.app.answer(question.id, rest.join(' ')); this.answerTarget = undefined; this.panel = undefined; this.wake(run.id); }
      else { this.answerTarget = question.id; this.panel = { title: 'Answer selected question', lines: [this.clean(question.content), `Question ${question.id}`, 'The next ordinary message answers only this question. Esc cancels the selection.'], items: [{ id: 'answer', label: 'Enter answer', input: `/tasks answer ${question.id} ` }] }; }
      return;
    }
    if (action === 'resolve') {
      if (!id) throw new KodoError('TUI_RESOLVE', 'Usage: /tasks resolve call-id. Review the observed result and evidence first.');
      const call = this.options.app.store.call(id); const owner = this.target(call.runId);
      if (!rest.length) {
        this.panel = { title: 'Review effects · Inspect original evidence first', lines: [`Call ${call.id}`, `${call.name} · ${call.status} · Effect ${call.effectOutcome ?? 'Needs review'}`, ...jsonLines(inspectRun(this.options.app.store, main, { run_id: owner.id, call_id: call.id, max_chars: 8000 })).map(line => this.clean(line)), 'Provide observed evidence; a model claim does not establish the outcome.'], items: [
          { id: 'applied', label: 'Enter applied evidence', input: `/tasks resolve ${id} applied ` }, { id: 'not-applied', label: 'Enter not-applied evidence', input: `/tasks resolve ${id} not_applied ` },
        ] }; return;
      }
      const outcome = rest[0]; const evidence = rest.slice(1).join(' ').trim();
      if (!['applied', 'not_applied'].includes(outcome ?? '') || !evidence) throw new KodoError('TUI_RESOLVE', 'Usage: /tasks resolve call-id applied|not_applied "observed evidence".');
      const result = this.options.app.resolveCall(call.id, outcome as 'applied' | 'not_applied', evidence);
      this.panel = { title: 'Review record', lines: jsonLines(result).map(line => this.clean(line)) }; return;
    }
    if (action === 'cancel' || action === 'resume') {
      if (id && this.processes.has(id)) throw new KodoError('TUI_TARGET', 'This is a process handle. Use the process read or stop actions.');
      const target = this.target(id);
      if (!target.parentId) throw new KodoError('TUI_TARGET', 'This action requires a selected direct child task. Use the composer, /stop or /cancel for the main task.');
      if (action === 'resume') {
        await this.ensureRestored(main);
        if (target.status !== 'interrupted' || !target.interruptRequested) throw new KodoError('TUI_RESUME', 'Only explicitly interrupted children can resume here. Use /resume for crash recovery.');
        this.options.app.coordinator.resumeInterrupted(target.id); this.wake(target.id); this.notice = `Resuming child task ${target.card.name}; the composer still addresses the main agent.`;
      } else {
        this.denyApprovals(target.id); this.options.app.cancelAgent(main.id, target.id); await this.options.app.coordinator.waitForStop(target.id); this.notice = `${target.card.name}: ${statusLabel[this.options.app.store.run(target.id).status]}; existing file changes are retained.`; }
      return;
    }
    const target = this.target(id);
    if (action === 'logs') {
      const after = Number(rest[0] ?? 0); if (!Number.isSafeInteger(after) || after < 0) throw new KodoError('TUI_CURSOR', 'The log cursor must be a nonnegative integer.');
      const page = this.options.app.calls(target.id, { after, limit: 20 });
      this.panel = { title: `${target.card.name} · Calls`, lines: ['Execution facts only. Internal model records are not tool output.'], items: [
        ...page.items.map(call => ({ id: call.id, label: `${call.kind === 'model' ? 'Model request' : call.name} · ${call.status} · Step ${call.step}`, ...(call.kind === 'tool' ? { command: `/tasks evidence ${target.id} ${call.id}` } : {}) })),
        ...(page.next === null ? [] : [{ id: 'next', label: 'Next page', command: `/tasks logs ${target.id} ${page.next}` }]),
      ] }; return;
    }
    if (action === 'evidence' || action === 'result') {
      const callId = action === 'evidence' ? rest[0] : undefined;
      if (action === 'evidence' && !callId) throw new KodoError('TUI_EVIDENCE', 'Select a tool call.');
      const offset = Number(rest[action === 'evidence' ? 1 : 0] ?? 0);
      const evidence = inspectRun(this.options.app.store, main, { run_id: target.id, ...(callId ? { call_id: callId } : {}), content_offset: offset, max_chars: 8000 }) as { evidence?: { next?: { content_offset: number } | null }; result?: { next?: { content_offset: number } | null } };
      const next = evidence.evidence?.next ?? evidence.result?.next;
      this.panel = { title: 'Original evidence · Page', lines: jsonLines(evidence).map(line => this.clean(line)), ...(next ? { items: [{ id: 'next', label: 'Next page', command: `/tasks ${action} ${target.id}${callId ? ` ${callId}` : ''} ${next.content_offset}` }] } : {}) }; return;
    }
    if (action !== 'show') throw new KodoError('TUI_TASKS', 'Use /tasks, show, logs, result, evidence, cancel, resume, answer or resolve.');
    const evidence = inspectRun(this.options.app.store, main, { run_id: target.id, max_chars: 8000 });
    const activity = this.options.app.store.latestEvent(target.id);
    this.panel = { title: `${target.parentId ? 'Child task' : 'Main task'} · ${target.card.name}`, lines: [
      `Objective: ${this.clean(target.objective)}`, `Version: ${target.card.id}@${target.card.version}`, `Run: ${statusLabel[target.status]}`,
      `Latest activity: ${activity ? `${activity.time} · ${activity.type}` : 'None'}`, `Active time: ${Math.round((target.activeMs ?? 0) / 1000)} seconds`,
      `Model: ${target.binding.model}`, `Tools: ${target.card.tools.join(', ')}`, `Write scope: ${JSON.stringify(target.scope?.write ?? ['.'])}`,
      ...jsonLines(evidence).map(line => this.clean(line)),
    ], items: [
      { id: 'logs', label: 'View calls', command: `/tasks logs ${target.id}` }, { id: 'result', label: 'Read original delivery', command: `/tasks result ${target.id}` },
      { id: 'changes', label: 'View task changes and deliverables', command: `/changes task ${target.id}` },
      ...(target.parentId && !terminal(target.status) ? [
        ...(target.status === 'interrupted' && target.interruptRequested ? [{ id: 'resume', label: 'Resume this child turn', command: `/tasks resume ${target.id}` }] : []),
        { id: 'cancel', label: 'Cancel this child (retain files)', command: `/tasks cancel ${target.id}` },
      ] : []),
    ] };
  }

  private async changes(args: string[], selected?: Run): Promise<void> {
    const main = this.requireRun(), run = selected ?? main, store = this.options.app.store;
    if (args[0] === 'task') { if (!args[1]) throw new KodoError('TUI_CHANGES', 'Select a main task or managed child.'); await this.changes(args.slice(2), this.target(args[1])); return; }
    const sources = selected ? [run] : this.familyRuns(), sourceIds = new Set(sources.map(owner => owner.id));
    const workspace = store.session(main.sessionId).workspace, prefix = selected ? `/changes task ${run.id}` : '/changes';
    const session = store.session(main.sessionId), readable = session.permissions.includes('read') && (main.permissions ?? session.permissions).includes('read');
    const visible = (file: string): boolean => { try { return readable && canAccessFileScope(main.scope, 'read', workspace, file); } catch { return false; } };
    const checkpoints = sources.flatMap(owner => [...store.checkpoints.list(owner.id)].reverse().map(checkpoint => ({ checkpoint, seq: store.latestEvent(owner.id, { types: ['file.recovery.prepared'], match: { id: checkpoint.preparationId } })?.seq ?? Number.MAX_SAFE_INTEGER }))).sort((left, right) => left.seq - right.seq).map(item => item.checkpoint);
    const recordedFiles = [...new Set(checkpoints.flatMap(checkpoint => Object.values(checkpoint.paths)))], files = recordedFiles.filter(visible);
    if (args[0] === 'artifact') {
      const artifact = store.artifactIds(main.sessionId).find(artifact => artifact.id === args[1] && sourceIds.has(artifact.runId));
      if (!artifact || !readable) throw new KodoError('TUI_ARTIFACT', 'Select a readable deliverable from the current task history.');
      const offset = Number(args[2] ?? 0); if (!Number.isSafeInteger(offset) || offset < 0) throw new KodoError('TUI_CURSOR', 'The deliverable cursor must be a nonnegative integer.');
      const text = this.clean(JSON.stringify(store.readArtifact(main.id, artifact.id), null, 2));
      if (offset > text.length) throw new KodoError('TUI_CURSOR', 'The deliverable cursor exceeds the content length.');
      this.panel = { title: 'Task deliverables · Page', lines: [`Owner task ${artifact.runId}`, text.slice(offset, offset + 8000)], items: offset + 8000 < text.length ? [{ id: 'next', label: 'Next deliverables', command: `${prefix} artifact ${artifact.id} ${offset + 8000}` }] : [] }; return;
    }
    if (args[0] === 'rewind') {
      const checkpoints = store.checkpoints.list(run.id);
      const toStep = args[1] === undefined ? undefined : Number(args[1]);
      if (toStep !== undefined && (!Number.isSafeInteger(toStep) || toStep < -1 || toStep > run.step)) throw new KodoError('REWIND_STEP', 'Select a valid checkpoint step.');
      if (args[2] === 'confirm' && toStep !== undefined) { await this.ensureRestored(main); const result = await this.options.app.rewind(run.id, toStep); this.panel = { title: 'Checkpoint restore result', lines: jsonLines(result) }; return; }
      const candidates = [...new Set(checkpoints.map(checkpoint => checkpoint.step - 1))].filter(step => step >= (store.checkpoints.floor(run.id) ?? -1));
      const preview = toStep === undefined ? checkpoints : checkpoints.filter(checkpoint => checkpoint.step > toStep);
      this.panel = { title: 'Restore file checkpoints · Preview', lines: [`Restore native file checkpoints for task ${run.id} only. Other task records and model history are retained.`, 'Stop execution first. Unknown writes, external changes, stale snapshots or scope changes block restoration.', ...preview.flatMap(checkpoint => Object.values(checkpoint.paths)).filter((file, index, all) => all.indexOf(file) === index && visible(file)).map(file => this.clean(path.relative(workspace, file)))], items: toStep === undefined ? candidates.map(step => ({ id: String(step), label: `Preview restore after step ${step} `, command: `${prefix} rewind ${step}` })) : [{ id: 'confirm', label: `Restore files after step ${toStep} `, command: `${prefix} rewind ${toStep} confirm` }] }; return;
    }
    if (args[0] === 'diff') {
      const requested = args.slice(1).join(' ');
      const chosen = requested ? files.filter(file => path.relative(workspace, file).replaceAll('\\', '/') === requested.replaceAll('\\', '/')) : files;
      if (!readable) throw new KodoError('TUI_READ', 'Viewing diffs requires read permission for the current run.');
      if (requested && !chosen.length) throw new KodoError('TUI_DIFF', 'No readable managed-task snapshot exists for this path. Whole-worktree changes cannot be attributed to this task.');
      const lines = ['Baseline: earliest retained native checkpoint in the selected task history. Right: current workspace files.', 'Other processes may have changed files. Snapshot provenance does not establish change ownership.'];
      for (const file of chosen.slice(0, 20)) {
        assertFileScope(main.scope, 'read', workspace, file);
        const original = checkpoints.find(checkpoint => Object.values(checkpoint.paths).includes(file))!;
        const key = Object.entries(original.paths).find(([, value]) => value === file)![0];
        const before = original.before[key];
        let oldText = '', newText = '';
        if (before?.kind === 'file') { if (!before.contentRef || before.bytes > 256_000) { lines.push(`${path.relative(session.workspace, file)}: original content is unavailable or too large; inspect checkpoint metadata.`); continue; } const body = store.readBlob<{ content: string }>(before.contentRef); oldText = Buffer.from(body.content, 'base64').toString('utf8'); }
        try { const info = await stat(actualPath(file)); if (!info.isFile() || info.size > 256_000) { lines.push(`${path.relative(workspace, file)}: currently a directory or oversized file.`); continue; } assertFileScope(main.scope, 'read', workspace, actualPath(file)); newText = await readFile(file, 'utf8'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        lines.push(`--- ${this.clean(path.relative(workspace, file))}(task ${original.runId} · Checkpoint ${original.id})`, `+++ Current workspace`, ...this.diff(oldText, newText));
      }
      this.panel = { title: 'Managed task diff', lines: lines.map(line => this.clean(line)).slice(0, 500), hint: chosen.length > 20 ? 'Showing up to 20 files. Use /changes diff "path" for one file.' : 'Diffs show up to 500 lines. Full files remain in the workspace.' }; return;
    }
    if (args.length) throw new KodoError('TUI_CHANGES', 'Use /changes, /changes diff [path] or /changes rewind.');
    const artifacts = store.artifactIds(run.sessionId).filter(artifact => sourceIds.has(artifact.runId));
    this.panel = { title: 'Changes and deliverables', lines: [
      `${selected ? 'Selected task' : 'Main and managed child task history'} ${run.id} · Native checkpoints ${checkpoints.length}`, ...files.map(file => `${this.clean(path.relative(workspace, file))} · Recorded by task ${[...new Set(checkpoints.filter(checkpoint => Object.values(checkpoint.paths).includes(file)).map(checkpoint => checkpoint.runId))].join(', ')}`),
      ...(files.length ? [] : ['No retained native file snapshots for this task. The workspace may still have changed.']),
      ...artifacts.slice(-50).map(artifact => `Deliverable ${artifact.id} · Task ${artifact.runId} · Decision version ${artifact.decisionVersion}`),
      ...(recordedFiles.length > files.length ? ['Some records fall outside the current read scope; their paths and contents are hidden.'] : []),
      'External command writes may lack restorable snapshots. Select an owner task before restoring files.',
    ], items: [{ id: 'diff', label: 'View selected task diff', command: `${prefix} diff` }, { id: 'rewind', label: `Preview ${selected ? 'Selected task' : 'Main task'} file restore...`, command: `${prefix} rewind` }, ...(!selected ? sources.filter(owner => owner.id !== main.id).map(owner => ({ id: owner.id, label: `View task ${owner.card.name} changes and restore actions`, detail: owner.id, command: `/changes task ${owner.id}` })) : []), ...artifacts.slice(-50).map(artifact => ({ id: artifact.id, label: `Read deliverable ${artifact.id}`, command: `${prefix} artifact ${artifact.id}` }))] };
  }

  private diff(before: string, after: string): string[] {
    if (before === after) return ['(matches retained baseline)'];
    if (before.includes('\0') || after.includes('\0')) return ['(binary content differs)'];
    const left = before.split('\n'), right = after.split('\n'); let start = 0, suffix = 0;
    while (start < left.length && start < right.length && left[start] === right[start]) start++;
    while (suffix < left.length - start && suffix < right.length - start && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix++;
    return [`@@ Old line ${start + 1}, new line ${start + 1} @@`, ...left.slice(Math.max(0, start - 2), start).map(line => ` ${line}`), ...left.slice(start, left.length - suffix).slice(0, 120).map(line => `-${line}`), ...right.slice(start, right.length - suffix).slice(0, 120).map(line => `+${line}`), ...(left.length - suffix - start > 120 || right.length - suffix - start > 120 ? ['(diff truncated)'] : []), ...right.slice(right.length - suffix, right.length - suffix + 2).map(line => ` ${line}`)];
  }

  private async check(args: string[]): Promise<void> {
    const run = this.requireRun(), { app } = this.options, store = app.store;
    if (!args.length) {
      const available = app.coordinator.tools.availableNames().includes('verify.run') || Boolean(this.options.completionValidator?.(run.id) ?? app.coordinator.completionValidators.get(run.id));
      this.panel = { title: 'Project verification', lines: [available ? 'Fixed host verification is configured and uses its approved permissions and scope.' : 'No verification command configured. Restart with --verification-config or --verify-command.', 'Verification may create reports or caches. Only fixed host-approved commands can run here.'], items: [...(available ? [{ id: 'run', label: 'Run configured verification', command: '/check run' }] : []), { id: 'results', label: 'View verification history', command: '/check results' }] }; return;
    }
    if (args[0] === 'results' || args[0] === 'evidence') {
      const records = this.familyRuns().flatMap(owner => [
        ...store.events(owner.id, { types: ['tui.check.finished', 'completion.checked'] }),
        ...store.events(owner.id, { types: ['tool.finished'], match: { name: 'verify.run' } }).map((event): RuntimeEvent => {
          const call = typeof event.data.callId === 'string' ? store.call(event.data.callId) : undefined;
          const result = call?.resultRef ? store.readBlob<{ passed?: boolean }>(call.resultRef) : undefined;
          return { ...event, data: { ...event.data, name: 'verify.run', passed: call?.status === 'succeeded' && result?.passed === true, evidenceRef: call?.resultRef, decisionVersion: call?.decisionVersion ?? 0 } };
        }),
      ]).sort((left, right) => right.seq - left.seq);
      if (args[0] === 'evidence') {
        const record = records.find(event => event.seq === Number(args[1]));
        if (typeof record?.data.evidenceRef !== 'string') throw new KodoError('TUI_CHECK', 'Select verification evidence from the current managed task history.');
        const offset = Number(args[2] ?? 0); if (!Number.isSafeInteger(offset) || offset < 0) throw new KodoError('TUI_CURSOR', 'The verification evidence cursor must be a nonnegative integer.');
        const text = this.clean(JSON.stringify(store.readBlob(record.data.evidenceRef), null, 2));
        if (offset > text.length) throw new KodoError('TUI_CURSOR', 'The verification evidence cursor exceeds the content length.');
        this.panel = { title: 'Verification evidence · Page', lines: [`Owner task ${record.runId}`, text.slice(offset, offset + 8000)], items: offset + 8000 < text.length ? [{ id: 'next', label: 'Next verification evidence', command: `/check evidence ${record.seq} ${offset + 8000}` }] : [] }; return;
      }
      const fingerprint = workspaceWrites(app.coordinator, run);
      const files = await captureVerificationFiles(app, run);
      const before = args[1] === undefined ? Infinity : Number(args[1]);
      if (!(before === Infinity && args[1] === undefined) && (!Number.isSafeInteger(before) || before < 1)) throw new KodoError('TUI_CURSOR', 'The verification history cursor must be a positive integer.');
      const remaining = records.filter(event => event.seq < before), events = remaining.slice(0, 20), decisionVersion = store.session(run.sessionId).decisionVersion ?? 0;
      this.panel = { title: 'Verification history and file versions', lines: ['File checks cover recorded authorized files only, not the entire workspace.', files.note, ...(events.length ? events.flatMap(event => {
        const original = event.data.fileState as Awaited<ReturnType<typeof captureVerificationFiles>> | undefined;
        const stale = (event.data.decisionVersion ?? 0) !== decisionVersion || event.type === 'tui.check.finished' && (event.data.workspaceStamp !== fingerprint.stamp || fingerprint.pending || Boolean(original && original.stamp !== files.stamp));
        const outcome = event.type === 'completion.checked' ? `Delivery ${String(event.data.deliveryPassed)} · Host quality ${String(event.data.qualityPassed ?? 'not_checked')} · Report ${String(event.data.reportPassed ?? 'not_required')}` : event.data.passed === true ? 'Passed' : 'Failed';
        return [`${event.time} · Task ${event.runId} · Decision version ${String(event.data.decisionVersion ?? 0)} · ${event.type === 'completion.checked' ? 'Completion check' : String(event.data.name)} · ${outcome}${stale ? ' · Stale result' : ''}`, original ? `Recorded files ${original.paths.length} · ${original.complete && files.complete ? 'Recorded files checked' : 'Incomplete file coverage; current validity is not fully established'}` : 'Historical check has no content fingerprints; external changes were not checked.', `Evidence ${String(event.data.evidenceRef ?? 'Not recorded')}`];
      }) : ['No host verification records yet.'])], items: [...events.filter(event => typeof event.data.evidenceRef === 'string').map(event => ({ id: String(event.seq), label: `Read verification evidence · ${event.time}`, command: `/check evidence ${event.seq}` })), ...(remaining.length > events.length ? [{ id: 'next', label: 'Earlier verification records', command: `/check results ${events.at(-1)!.seq}` }] : [])] }; return;
    }
    if (args[0] !== 'run' || args.length > 2 || (args[1] && !['default', 'verify.run', 'completion'].includes(args[1]))) throw new KodoError('TUI_CHECK', 'Use /check run [default|verify.run|completion]; commands must come from host configuration.');
    if (this.hasActive()) throw new KodoError('TUI_CHECK_ACTIVE', 'Stop session execution before verifying a stable file version.');
    await this.ensureRestored(run); await this.options.beforeRun?.(run.id);
    const verifyTool = args[1] !== 'completion' && app.coordinator.tools.availableNames().includes('verify.run');
    const validator = this.options.completionValidator?.(run.id) ?? app.coordinator.completionValidators.get(run.id);
    if (!verifyTool && !validator) throw new KodoError('TUI_CHECK_UNAVAILABLE', 'No host verification command is bound.');
    if (args[1] === 'verify.run' && !verifyTool) throw new KodoError('TUI_CHECK_UNAVAILABLE', 'verify.run is not configured.');
    const control = new AbortController(); this.checks.add(control);
    const name = verifyTool ? 'verify.run' : 'completion', before = workspaceWrites(app.coordinator, run);
    this.notice = 'Running host verification; no model request.'; this.notify(true);
    const work = this.performCheck(run, name, validator, control, before.stamp).catch(error => { this.notice = this.clean(errorText(error)); this.put({ id: `check-error:${randomUUID()}`, kind: 'error', text: this.notice }); }).finally(() => { this.checks.delete(control); this.running.delete(`check:${run.id}`); this.notify(true); });
    this.running.set(`check:${run.id}`, work);
  }

  private async performCheck(run: Run, name: string, validator: import('../runtime/types.js').CompletionValidator | undefined, control: AbortController, beforeStamp: string): Promise<void> {
    const { app } = this.options, store = app.store;
    const timeout = AbortSignal.timeout(store.session(run.sessionId).budget.toolTimeoutMs), signal = AbortSignal.any([control.signal, timeout]);
    const decisionVersion = store.session(run.sessionId).decisionVersion ?? 0;
    let result: Record<string, unknown>, recorded: Call | undefined;
    try {
      const beforeFiles = await captureVerificationFiles(app, run); signal.throwIfAborted();
      if (name === 'verify.run') {
        const session = store.session(run.sessionId);
        app.coordinator.tools.validate('verify.run', '{}', run.card.tools, { ...session, permissions: session.permissions.filter(permission => (run.permissions ?? session.permissions).includes(permission)) }, run);
        const roots = app.coordinator.tools.effectRoots(run.id, name, {}); app.coordinator.tools.assertWriteScope(run.id, roots);
        recorded = { id: `tui-check:${randomUUID()}`, runId: run.id, step: run.step, kind: 'tool', name, status: 'running', effect: 'write', evidencePermission: 'exec', requestRef: store.blob({ id: 'tui-check', name, arguments: '{}' }), reservedTokens: 0, effectState: 'not_started', effectRoots: roots, decisionVersion: session.decisionVersion ?? 0 };
        store.transaction(() => {
          if (session.budget.maxToolCalls !== null && session.toolCalls >= session.budget.maxToolCalls) throw new KodoError('TOOL_BUDGET', 'tool call budget exhausted');
          store.putSession({ ...session, toolCalls: session.toolCalls + 1 }); store.putCall(recorded!); store.event(run.id, 'tool.started', { callId: recorded!.id, name });
        });
        const settle = (value: unknown, failed = false): void => {
          const current = store.call(recorded!.id); const uncertain = current.effectState === 'started' && (failed || Boolean(value && typeof value === 'object' && 'effectUnknown' in value && value.effectUnknown));
          const status = uncertain ? 'unknown' : failed ? 'failed' : 'succeeded', resultRef = store.blob(value);
          store.putCall({ ...current, status, resultRef, effectOutcome: uncertain ? 'unknown' : current.effectState === 'started' ? 'applied' : 'not_applied' });
          store.event(run.id, 'tool.finished', { callId: current.id, name, status, resultRef });
        };
        result = await app.coordinator.tools.execute(run.id, name, {}, signal, () => { store.putCall({ ...store.call(recorded!.id), effectState: 'started' }); }, { callId: recorded.id, settle: settlement => { settle(settlement.ok ? settlement.result : { error: errorText(settlement.error) }, !settlement.ok); } }) as Record<string, unknown>;
      } else {
        const saved = run.resultRef ? store.readBlob<{ text?: string }>(run.resultRef) : undefined;
        result = await validator!({ run, response: { message: { role: 'assistant', content: saved?.text ?? '' }, finishReason: 'stop' }, signal }) as unknown as Record<string, unknown>;
      }
      signal.throwIfAborted();
      const after = workspaceWrites(app.coordinator, run);
      const fileState = await captureVerificationFiles(app, run); signal.throwIfAborted();
      // verify.run itself is a write effect and must be part of the resulting version.
      const stable = !after.pending && (name === 'verify.run' || beforeStamp === after.stamp) && beforeFiles.stamp === fileState.stamp && decisionVersion === (store.session(run.sessionId).decisionVersion ?? 0);
      const passed = result.passed === true && stable;
      const evidenceRef = store.blob({ name, passed, workspaceStable: stable, fileState, result });
      store.event(run.id, 'tui.check.finished', { name, passed, evidenceRef, workspaceStamp: after.stamp, fileState, decisionVersion });
      this.notice = passed ? `Host verification passed; content coverage: ${fileState.paths.length} recorded files${fileState.complete ? '' : ' (incomplete coverage)'}.` : 'Host verification failed or file state changed. See /check results.';
      this.panel = { title: 'Host verification result', lines: [this.notice, fileState.note, `Evidence ${evidenceRef}`, ...jsonLines(result).map(line => this.clean(line))] };
    } catch (error) {
      const evidenceRef = store.blob({ name, passed: false, error: errorText(error) });
      if (recorded) { const call = store.call(recorded.id); if (call.status === 'running') { const unknown = call.effectState === 'started'; store.putCall({ ...call, status: unknown ? 'unknown' : 'failed', effectOutcome: unknown ? 'unknown' : 'not_applied', resultRef: evidenceRef }); } }
      store.event(run.id, 'tui.check.finished', { name, passed: false, evidenceRef, workspaceStamp: workspaceWrites(app.coordinator, run).stamp, decisionVersion });
      throw error;
    }
  }

  private context(args: string[]): void {
    const run = this.requireRun();
    if (args[0] === 'compact') { this.panel = { title: 'Context compaction', lines: ['Compaction runs automatically in the kernel. Manual compaction is not available.', 'Use /context to inspect the current projection and archived sources.'] }; return; }
    if (args.length && !['sources', 'usage'].includes(args[0]!)) throw new KodoError('TUI_CONTEXT', 'Use /context, /context sources or /context usage.');
    const value = args[0] === 'usage' ? this.options.app.contextReport(run.id) : this.options.app.context(run.id);
    const priceLines: string[] = [];
    if (args[0] === 'usage' && this.options.rates && 'usage' in value) {
      const usage = value.usage as { knownInput: number; knownOutput: number; unknownCalls: number };
      const cost = (usage.knownInput * this.options.rates.input + usage.knownOutput * this.options.rates.output) / 1_000_000;
      priceLines.push(`Known token cost estimate: $${cost.toFixed(6)} USD${usage.unknownCalls ? `; ${usage.unknownCalls} requests with unknown usage are excluded` : ''}.`, 'Estimated from the configured input/output rates; excludes cache discounts, non-token charges and unknown usage.');
    }
    this.panel = { title: args[0] === 'usage' ? 'Context and session usage' : args[0] === 'sources' ? 'Context projection and sources' : 'Current context', lines: [this.snapshot().usage, ...priceLines, ...jsonLines(value).map(line => this.clean(line))], items: [{ id: 'usage', label: 'View main and child usage', command: '/context usage' }, { id: 'sources', label: 'View current source projection', command: '/context sources' }] };
  }

  async completeFiles(query: string): Promise<TuiItem[]> {
    const run = this.current(), session = run ? this.options.app.store.session(run.sessionId) : undefined;
    if (!(session?.permissions ?? this.options.permissions).includes('read') || (run?.permissions && !run.permissions.includes('read'))) throw new KodoError('TUI_READ', 'File suggestions require read permission.');
    const workspace = session?.workspace ?? this.options.workspace;
    query = query.replace(/^@/u, '').replaceAll('\\', '/');
    if (query.length > 4096 || Array.from(query).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || path.isAbsolute(query) || query.split('/').includes('..')) throw new KodoError('TUI_FILES', 'Only workspace-relative paths can be searched.');
    const privateRoot = actualPath(this.options.app.store.directory);
    const prefix = path.posix.dirname(query);
    if (prefix.split('/').some(part => ['.git', 'node_modules', '.state', '.kodo'].includes(part))) return [];
    const directories = [prefix === '.' ? '.' : prefix], matches: string[] = []; let visited = 0;
    if (prefix !== '.') {
      try { if (!(await stat(path.resolve(workspace, prefix))).isDirectory()) return []; }
      catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return []; throw error; }
    }
    while (directories.length && visited < 100 && matches.length < 60) {
      const directory = directories.shift()!, target = path.resolve(workspace, directory); visited++;
      if (!canAccessFileScope(run?.scope, 'read', workspace, target, true)) continue;
      const entries = await readdir(target, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 1000)) {
        if (entry.isSymbolicLink() || ['.git', 'node_modules', '.state', '.kodo'].includes(entry.name)) continue;
        const relative = path.posix.join(directory.replaceAll('\\', '/'), entry.name), file = path.resolve(workspace, relative);
        if (entry.isDirectory() && actualPath(file) === privateRoot) continue;
        if (entry.isDirectory() && directories.length < 100 && canAccessFileScope(run?.scope, 'read', workspace, file, true)) directories.push(relative);
        else if (entry.isFile() && relative.toLowerCase().includes(query.toLowerCase()) && canAccessFileScope(run?.scope, 'read', workspace, file)) matches.push(relative);
        if (matches.length >= 60) break;
      }
    }
    return matches.map(file => ({ id: file, label: file, input: `@${file.includes(' ') ? quoteArgument(file) : file}` }));
  }

  private async files(query: string): Promise<void> {
    const items = await this.completeFiles(query);
    this.panel = { title: 'Reference workspace files', lines: ['Inserts a relative path. The agent reads file contents only with permission.', ...(items.length ? [] : ['No matching files in this scope.'])], items, hint: 'Search is bounded. Type a more specific path to refine results.' };
  }
}
