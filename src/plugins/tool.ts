import type { RuntimeCore } from '../core/runtime.js';
import type { ToolSpec } from '../core/types.js';

/** A model-visible tool: name, description and JSON Schema parameters. */
export type ToolDefinition = ToolSpec;

/** What a tool receives besides its arguments. */
export interface ToolContext {
  runId: string;
  sessionId: string;
  /** Aborted when the run is cancelled; long tools must honour it. */
  signal: AbortSignal;
}

/**
 * A Tool plugin contributes a set of tools. Tool names must be unique across all
 * registered plugins; the registry rejects a duplicate when the plugin is added to the core.
 *
 * `execute` returns any JSON-serialisable value, which becomes the tool result the model
 * sees. A thrown error becomes `{ error }` for the model and the run continues.
 */
export interface ToolPlugin {
  readonly kind?: 'tool';
  readonly name: string;
  readonly version?: string;
  readonly tools: readonly ToolDefinition[];
  /** Open connections or caches. Called once before any run starts. */
  initialize?(runtime: RuntimeCore): Promise<void> | void;
  /** `args` is the parsed JSON the model sent; validate it before use. */
  execute(toolName: string, args: unknown, context: ToolContext): Promise<unknown> | unknown;
  cleanup?(): Promise<void> | void;
}
