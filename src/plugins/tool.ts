import type { RuntimeCore } from '../core/runtime.js';
import type { ToolSpec } from '../core/types.js';
import type { ToolRegistration } from '../tools/registry.js';

/**
 * Execution policy a tool may declare, taken unchanged from `ToolRegistration`.
 * The core ignores these fields; a `ToolBoundary` (Layer 2) reads them for approval,
 * write locks, batching and crash recovery. Omitted fields take the conservative path there.
 */
export type ToolPolicy = Partial<Pick<ToolRegistration,
  'permission' | 'effect' | 'version' | 'available' | 'readOnly' | 'concurrencySafe' | 'destructive' | 'writeScope' | 'interrupt' | 'maxResultBytes' | 'validate' | 'recover'>>;

/** A model-visible tool (name, description, JSON Schema parameters) plus optional policy. */
export type ToolDefinition = ToolSpec & ToolPolicy;

/** What a tool receives besides its arguments. */
export interface ToolContext {
  runId: string;
  sessionId: string;
  /** Aborted when the run is cancelled; long tools must honour it. */
  signal: AbortSignal;
  /**
   * Call immediately before the first externally visible effect. A no-op in the bare
   * core; a boundary replaces it to record effect state for recovery.
   */
  markEffectStarted: () => void;
}

/**
 * A Tool plugin contributes a set of tools. Tool names must be unique across all
 * registered plugins; the core rejects a duplicate when the plugin is registered.
 *
 * `execute` returns any JSON-serialisable value, which becomes the tool result the model
 * sees. A thrown error becomes `{ error }` for the model and the run continues.
 */
export interface ToolPlugin {
  readonly kind?: 'tool';
  readonly name: string;
  readonly version?: string;
  /** Names of plugins (of any kind) that must initialise before this one. */
  readonly dependsOn?: readonly string[];
  readonly tools: readonly ToolDefinition[];
  /** Open connections or caches. Called once before any run starts. */
  initialize?(runtime: RuntimeCore): Promise<void> | void;
  /** `args` is the parsed JSON the model sent; validate it before use. */
  execute(toolName: string, args: unknown, context: ToolContext): Promise<unknown> | unknown;
  cleanup?(): Promise<void> | void;
}

/** One tool invocation as seen by a boundary. */
export interface BoundaryCall { plugin: ToolPlugin; definition: ToolDefinition; args: unknown; context: ToolContext }

/**
 * The shared execution boundary around every tool call: approval, permission checks,
 * write locks, effect marking and reconciliation. At most one per runtime; it lives in
 * Layer 2, not in the core. It must call `invoke` to run the tool (passing a context
 * with its own `markEffectStarted`) or throw to refuse; a throw becomes the tool error.
 */
export interface ToolBoundary {
  execute(call: BoundaryCall, invoke: (context: ToolContext) => Promise<unknown>): Promise<unknown>;
}
