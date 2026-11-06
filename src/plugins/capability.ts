import type { RuntimeCore } from '../core/runtime.js';
import type { CoreRun, CoreToolCall, Message } from '../core/types.js';

/** What a `beforeModelCall` hook may change; see the hook. */
export interface ModelCallChange { inject?: Message[]; view?: Message[] }

/**
 * A Capability plugin adds optional behaviour (history, compaction, recovery, analysis)
 * around the core loop. It never owns the loop: it observes and, where a hook allows,
 * adjusts what the core does next.
 *
 * Hooks run in registration order and are awaited. A hook that throws fails the run,
 * so a plugin that must not affect execution should catch its own errors.
 */
export interface CapabilityPlugin {
  readonly kind?: 'capability';
  readonly name: string;
  readonly version: string;
  /** Names of plugins (of any kind) that must initialise before this one. */
  readonly dependsOn?: readonly string[];
  /** Called once by the registry before any run starts. */
  initialize?(runtime: RuntimeCore): Promise<void> | void;
  hooks?: CapabilityHooks;
  /** Called once by the registry on shutdown, in reverse registration order. */
  cleanup?(): Promise<void> | void;
}

export interface CapabilityHooks {
  /**
   * Before each model request. `messages` is what the model will see, after earlier
   * plugins' changes. Return:
   * - `{ inject }` to append messages (notices, mailbox, background output) to the run's
   *   transcript; they are kept and seen by every later request and by later plugins;
   * - `{ view }` to replace what the model sees for this request only (a compacted view);
   *   the transcript is not rewritten;
   * - both, or nothing.
   */
  beforeModelCall?(run: CoreRun, messages: Message[]): Promise<ModelCallChange | void> | ModelCallChange | void;
  /** After each tool call settles, successful or not. */
  afterToolResult?(run: CoreRun, call: CoreToolCall): Promise<void> | void;
  /**
   * When the model ends a turn without tool calls. Return `{ deny: reason }` to keep the
   * run going: the reason is appended as a user message and the model is called again.
   */
  beforeCompletion?(run: CoreRun): Promise<{ deny: string } | void> | { deny: string } | void;
  /** After the run is marked failed. */
  onRunFailed?(run: CoreRun, error: unknown): Promise<void> | void;
}
// Plugin-specific notifications (for example task-analysis's graph) are not core hooks:
// use `runtime.events.on(name, ...)` / `runtime.events.emit(name, payload)`.
