import type { RuntimeCore } from '../core/runtime.js';
import type { IntegrationPlugin, IntegrationCommand } from '../plugins/integration.js';
import type { ModelBinding } from '../core/types.js';
import { runCli } from '../cli/index.js';

/**
 * CliIntegrationPlugin exposes the CLI as an integration.
 *
 * This is a thin wrapper with two layers:
 *
 * 1. **API layer** (7 methods): RuntimeCore's core operations (run, createSession,
 *    startRun, advance, cancel, getRun, listTools). These are the fundamental
 *    runtime capabilities.
 *
 * 2. **CLI layer** (18+ commands): Full CLI command set (config, package, case,
 *    serve, spawn, runs, gc, inspect, context, resume, reconcile, continue, input,
 *    answer, cancel, interrupt, rewind, doctor, etc.). These route through runCli()
 *    to src/cli/index.ts, preserving all existing behavior.
 *
 * The plugin does not reimplement RunCoordinator, persistence, or recovery; those
 * remain in src/cli/ and src/application/ until Phase 2 migrates them to plugins.
 *
 * @example
 * ```typescript
 * // API usage
 * const result = await api.run('Summarize this', { system: 'Be concise' });
 *
 * // CLI usage (via registry)
 * const cli = registry.integration('cli');
 * await cli.cli.find(cmd => cmd.name === 'doctor').handler({ unlock: false });
 * ```
 */
export class CliIntegrationPlugin implements IntegrationPlugin {
  readonly kind = 'integration' as const;
  readonly name = 'cli';
  readonly version = '0.1.0';

  private runtime!: RuntimeCore;

  async initialize(runtime: RuntimeCore): Promise<void> {
    this.runtime = runtime;
  }

  getInterface() {
    // Full CLI command set from src/cli/index.ts
    const cliCommands: IntegrationCommand[] = [
      // Special command routers
      { name: 'config', description: 'Manage provider credentials and model selection', handler: this.cliHandler.bind(this) },
      { name: 'package', description: 'Manage capability packages', handler: this.cliHandler.bind(this) },
      { name: 'case', description: 'Manage evaluation cases', handler: this.cliHandler.bind(this) },
      { name: 'serve', description: 'Start the workbench server', handler: this.cliHandler.bind(this) },
      // Main run commands
      { name: 'run', description: 'Run a prompt and capture output', handler: this.cliHandler.bind(this) },
      { name: 'chat', description: 'Interactive terminal mode (default for TTY)', handler: this.cliHandler.bind(this) },
      { name: 'spawn', description: 'Create a child run from a trusted host', handler: this.cliHandler.bind(this) },
      { name: 'runs', description: 'List runs in a session', handler: this.cliHandler.bind(this) },
      { name: 'gc', description: 'Garbage collection and pruning', handler: this.cliHandler.bind(this) },
      // Inspection and control
      { name: 'inspect', description: 'Inspect a run by ID', handler: this.cliHandler.bind(this) },
      { name: 'context', description: 'Print context window state', handler: this.cliHandler.bind(this) },
      { name: 'context-report', description: 'Aggregate context data across the run', handler: this.cliHandler.bind(this) },
      { name: 'knowledge', description: 'Query run knowledge base', handler: this.cliHandler.bind(this) },
      { name: 'resume', description: 'Resume a waiting run', handler: this.cliHandler.bind(this) },
      { name: 'reconcile', description: 'Review and approve/reject uncertain actions', handler: this.cliHandler.bind(this) },
      { name: 'resolve', description: 'Resolve a specific action call', handler: this.cliHandler.bind(this) },
      { name: 'continue', description: 'Continue a completed run', handler: this.cliHandler.bind(this) },
      { name: 'input', description: 'Send input to an awaiting run', handler: this.cliHandler.bind(this) },
      { name: 'answer', description: 'Answer a question', handler: this.cliHandler.bind(this) },
      { name: 'cancel', description: 'Cancel an active run', handler: this.cliHandler.bind(this) },
      { name: 'interrupt', description: 'Interrupt a run mid-turn', handler: this.cliHandler.bind(this) },
      { name: 'rewind', description: 'Rewind a run to a prior step', handler: this.cliHandler.bind(this) },
      { name: 'doctor', description: 'Diagnostics and sandbox health check', handler: this.cliHandler.bind(this) },
    ];

    return {
      api: {
        run: this.run.bind(this),
        createSession: this.createSession.bind(this),
        startRun: this.startRun.bind(this),
        advance: this.advance.bind(this),
        cancel: this.cancel.bind(this),
        getRun: this.getRun.bind(this),
        listTools: this.listTools.bind(this),
      },
      cli: cliCommands,
    };
  }

  async cleanup(): Promise<void> {
    // The runtime owns its lifecycle; nothing extra to clean up.
  }

  // API methods

  /**
   * Create a session and run a prompt to completion.
   *
   * @example
   * ```typescript
   * const result = await api.run('Summarize this file', { system: 'Be concise' });
   * console.log(result.result); // final assistant text
   * ```
   */
  async run(
    prompt: string,
    options: { system?: string; sessionId?: string } = {}
  ): Promise<{ id: string; status: string; result?: string; error?: string; usage: { input: number; output: number } }> {
    const run = await this.runtime.run(prompt, options);
    return {
      id: run.id,
      status: run.status,
      result: run.result,
      error: run.error,
      usage: run.usage,
    };
  }

  /**
   * Create a new session.
   *
   * @example
   * ```typescript
   * const session = api.createSession({ binding: myBinding });
   * console.log(session.id);
   * ```
   */
  createSession(options: { binding?: ModelBinding; metadata?: Record<string, unknown> } = {}): { id: string } {
    const session = this.runtime.createSession(options);
    return { id: session.id };
  }

  /**
   * Queue a run; call `advance` to execute it.
   */
  startRun(sessionId: string, prompt: string, options: { system?: string } = {}): { id: string; status: string } {
    const run = this.runtime.startRun(sessionId, prompt, options);
    return { id: run.id, status: run.status };
  }

  /**
   * Drive a run to completion. Concurrent calls for one run share one execution.
   */
  async advance(runId: string): Promise<{ id: string; status: string; result?: string; error?: string }> {
    const run = await this.runtime.advance(runId);
    return { id: run.id, status: run.status, result: run.result, error: run.error };
  }

  /**
   * Cancel an active run.
   */
  cancel(runId: string): void {
    this.runtime.cancel(runId);
  }

  /**
   * Inspect a run by ID.
   */
  getRun(runId: string): { id: string; status: string; step: number; result?: string; error?: string; usage: { input: number; output: number } } | undefined {
    try {
      const run = this.runtime.runs.get(runId);
      return {
        id: run.id,
        status: run.status,
        step: run.step,
        result: run.result,
        error: run.error,
        usage: run.usage,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * List available tool specifications.
   */
  listTools(): { name: string; description: string; parameters: Record<string, unknown> }[] {
    return this.runtime.toolSpecs;
  }

  // CLI command handler: unified forwarding to runCli

  private readonly cliHandler: (args: Record<string, unknown>) => Promise<unknown> = async (args) => {
    // Extract the command name and arguments from the handler's args object.
    // The caller (PluginRegistry CLI dispatcher) should provide:
    // - _command: string (the command name)
    // - All other fields as command-line arguments
    const commandName = args._command as string | undefined;
    if (!commandName) throw new Error('Internal error: CLI handler requires _command');

    // Build argv: [commandName, ...converted args]
    const argv: string[] = [commandName];

    // Convert args object to command-line arguments
    // Flags (boolean true) become --flag
    // Strings become --key value (or --key=value)
    for (const [key, value] of Object.entries(args)) {
      if (key === '_command') continue;
      if (typeof value === 'string') {
        argv.push(`--${key}=${value}`);
      } else if (typeof value === 'boolean' && value) {
        argv.push(`--${key}`);
      } else if (typeof value === 'boolean') {
        // false values are skipped
      } else if (typeof value === 'number') {
        argv.push(`--${key}=${value}`);
      }
    }

    // Forward to runCli
    return await runCli(argv);
  };

  // Legacy API command handlers (for tests)

  private readonly runCommand: (args: Record<string, unknown>) => Promise<unknown> = async (args) => {
    const prompt = args.prompt as string | undefined;
    if (!prompt) throw new Error('cli run requires a prompt');
    const system = args.system as string | undefined;
    return this.run(prompt, system ? { system } : {});
  };

  private readonly sessionCommand: (args: Record<string, unknown>) => Promise<unknown> = async () => {
    return this.createSession();
  };

  private readonly inspectCommand: (args: Record<string, unknown>) => Promise<unknown> = async (args) => {
    const runId = args.runId as string | undefined;
    if (!runId) throw new Error('cli inspect requires a runId');
    const run = this.getRun(runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    return run;
  };

  private readonly toolsCommand: (args: Record<string, unknown>) => Promise<unknown> = async () => {
    return this.listTools();
  };

  private readonly cancelCommand: (args: Record<string, unknown>) => Promise<unknown> = async (args) => {
    const runId = args.runId as string | undefined;
    if (!runId) throw new Error('cli cancel requires a runId');
    this.cancel(runId);
    return { cancelled: runId };
  };
}
