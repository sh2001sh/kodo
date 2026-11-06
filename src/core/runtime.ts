import { errorText, KodoError } from '../runtime/types.js';
import type { CapabilityPlugin } from '../plugins/capability.js';
import type { ToolPlugin } from '../plugins/tool.js';
import { RunTable } from './run.js';
import { SessionTable } from './session.js';
import { ToolDispatcher } from './tool-dispatch.js';
import { isTerminal } from './types.js';
import type { CoreRun, CoreSession, Message, ModelBinding, Provider } from './types.js';

export interface RuntimeCoreOptions {
  /** Model rounds per run before it fails with STEP_LIMIT. */
  maxSteps?: number;
  maxOutputTokens?: number;
  /** Streamed assistant text. */
  onText?: (runId: string, text: string) => void;
}

/**
 * Layer 1: the model loop and tool dispatch, nothing else. Persistence, recovery,
 * compaction, permissions and delegation are plugins on top of this.
 */
export class RuntimeCore {
  readonly sessions = new SessionTable();
  readonly runs = new RunTable();
  private readonly dispatcher = new ToolDispatcher();
  private readonly capabilities: CapabilityPlugin[] = [];
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<CoreRun> }>();
  constructor(readonly provider: Provider, readonly defaultBinding: ModelBinding, private readonly options: RuntimeCoreOptions = {}) {}

  registerCapability(plugin: CapabilityPlugin): void { this.capabilities.push(plugin); }
  registerTools(plugin: ToolPlugin): void { this.dispatcher.add(plugin); }
  get toolSpecs() { return this.dispatcher.specs(); }

  createSession(options: { binding?: ModelBinding; metadata?: Record<string, unknown> } = {}): CoreSession {
    return this.sessions.create(options.binding ?? this.defaultBinding, options.metadata);
  }
  /** Queue a run; `advance` executes it. */
  startRun(sessionId: string, prompt: string, options: { system?: string } = {}): CoreRun {
    this.sessions.get(sessionId);
    const messages: Message[] = [...(options.system ? [{ role: 'system' as const, content: options.system }] : []), { role: 'user', content: prompt }];
    return this.runs.create(sessionId, messages);
  }
  /** Convenience: create, start and advance in one call. */
  async run(prompt: string, options: { system?: string; sessionId?: string } = {}): Promise<CoreRun> {
    return this.advance(this.startRun(options.sessionId ?? this.createSession().id, prompt, options).id);
  }
  /** Drive the run until it ends. Concurrent calls for one run share one execution. */
  advance(runId: string): Promise<CoreRun> {
    const existing = this.active.get(runId);
    if (existing) return existing.promise;
    const run = this.runs.get(runId);
    if (isTerminal(run.status)) return Promise.resolve(run);
    const controller = new AbortController();
    const promise = this.loop(runId, controller.signal).finally(() => this.active.delete(runId));
    this.active.set(runId, { controller, promise });
    return promise;
  }
  cancel(runId: string): void {
    const run = this.runs.get(runId);
    if (isTerminal(run.status)) return;
    this.runs.update(runId, { status: 'cancelled' });
    this.active.get(runId)?.controller.abort(new KodoError('CANCELLED', 'run cancelled'));
  }
  async shutdown(): Promise<void> {
    for (const id of this.active.keys()) this.cancel(id);
    await Promise.allSettled([...this.active.values()].map(entry => entry.promise));
  }

  private async loop(runId: string, signal: AbortSignal): Promise<CoreRun> {
    const maxSteps = this.options.maxSteps ?? 50;
    try {
      this.runs.update(runId, { status: 'running' });
      for (;;) {
        signal.throwIfAborted();
        let run = this.runs.get(runId);
        if (run.step >= maxSteps) throw new KodoError('STEP_LIMIT', `run exceeded ${maxSteps} model rounds`);
        let messages = run.messages;
        for (const cap of this.capabilities) messages = (await cap.hooks?.beforeModelCall?.(run, messages)) ?? messages;
        const session = this.sessions.get(run.sessionId);
        const response = await this.provider.complete({
          binding: session.binding, messages, tools: this.dispatcher.specs(),
          maxOutputTokens: this.options.maxOutputTokens ?? session.binding.limits?.output ?? 8192,
        }, signal, text => this.options.onText?.(runId, text));
        signal.throwIfAborted();
        run = this.runs.update(runId, {
          messages: [...run.messages, response.message], step: run.step + 1,
          usage: { input: run.usage.input + (response.usage?.input ?? 0), output: run.usage.output + (response.usage?.output ?? 0) },
        });
        const requests = response.message.tool_calls ?? [];
        if (requests.length) {
          // Sequential by design: ordering and concurrency policy belong to plugins.
          for (const request of requests) {
            const call = await this.dispatcher.dispatch(request, { runId, sessionId: run.sessionId, signal });
            const content = JSON.stringify(call.status === 'succeeded' ? call.result ?? null : { error: call.error });
            run = this.runs.update(runId, { messages: [...this.runs.get(runId).messages, { role: 'tool', tool_call_id: request.id, content }] });
            for (const cap of this.capabilities) await cap.hooks?.afterToolResult?.(run, call);
          }
          continue;
        }
        let denied: string | undefined;
        for (const cap of this.capabilities) denied ??= (await cap.hooks?.beforeCompletion?.(run))?.deny;
        if (denied !== undefined) { this.runs.update(runId, { messages: [...run.messages, { role: 'user', content: denied }] }); continue; }
        return this.runs.update(runId, { status: 'completed', result: response.message.content ?? '' });
      }
    } catch (error) {
      if (this.runs.get(runId).status === 'cancelled') return this.runs.get(runId);
      const failed = this.runs.update(runId, { status: 'failed', error: errorText(error) });
      for (const cap of this.capabilities) {
        try { await cap.hooks?.onRunFailed?.(failed, error); }
        catch { /* The original failure stays the reported cause. */ }
      }
      return this.runs.get(runId);
    }
  }
}
