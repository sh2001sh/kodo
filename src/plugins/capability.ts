import type { RuntimeCore } from '../core/runtime.js';
import type { CoreRun, CoreToolCall, Message } from '../core/types.js';

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
  /** Called once by the registry before any run starts. */
  initialize?(runtime: RuntimeCore): Promise<void> | void;
  hooks?: CapabilityHooks;
  /** Called once by the registry on shutdown, in reverse registration order. */
  cleanup?(): Promise<void> | void;
}

export interface CapabilityHooks {
  /**
   * Before each model request. Return a replacement message list to change what the
   * model sees for this request only (for example a compacted view); the run's own
   * transcript is not rewritten. Return nothing to leave it as is.
   */
  beforeModelCall?(run: CoreRun, messages: Message[]): Promise<Message[] | void> | Message[] | void;
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
