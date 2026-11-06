import type { RuntimeCore } from '../core/runtime.js';

/** A command an integration offers to a command-line host. */
export interface IntegrationCommand {
  name: string;
  description: string;
  handler(args: Record<string, unknown>): Promise<unknown> | unknown;
}

/** Entry points an integration exposes. Every field is optional. */
export interface IntegrationInterface {
  /** Programmatic API, for embedding hosts and evaluation harnesses. */
  api?: Record<string, (...args: never[]) => unknown>;
  /** Commands for a CLI host. */
  cli?: IntegrationCommand[];
}

/**
 * An Integration plugin connects the runtime to an application (CLI, eval, dashboard,
 * an embedding service). It drives the core through its public methods and does not
 * participate in the loop; use a CapabilityPlugin for that.
 */
export interface IntegrationPlugin {
  readonly kind?: 'integration';
  readonly name: string;
  readonly version?: string;
  /** Names of plugins (of any kind) that must initialise before this one. */
  readonly dependsOn?: readonly string[];
  /** Receives the core it will drive; keep the reference for `getInterface`. */
  initialize(runtime: RuntimeCore): Promise<void> | void;
  /** Called after `initialize`; may be called more than once. */
  getInterface(): IntegrationInterface;
  cleanup?(): Promise<void> | void;
}
