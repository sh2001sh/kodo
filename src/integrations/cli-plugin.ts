import type { RuntimeCore } from '../core/runtime.js';
import type { IntegrationPlugin } from '../plugins/integration.js';
import type { ModelBinding } from '../core/types.js';

/**
 * CliIntegrationPlugin exposes the runtime's core operations as CLI commands
 * and a programmatic API.
 *
 * This is a thin wrapper: it delegates to RuntimeCore's public methods and
 * does not reimplement the full CLI argument parsing or the RunCoordinator
 * (persistence, recovery, multi-agent). Those remain in src/cli/ and
 * src/application/ until Phase 2 migrates them to plugins.
 *
 * API interface:
 * - run(prompt, options): Create a session and run a prompt to completion
 * - createSession(binding?): Create a new session
 * - startRun(sessionId, prompt, options): Queue a run
 * - advance(runId): Drive a run to completion
 * - cancel(runId): Cancel an active run
 * - getRun(runId): Inspect a run's state
 * - listTools(): List available tool specs
 *
 * CLI interface:
 * - run: Run a prompt through the core
 * - session: Create a session
 * - inspect: Inspect a run
 * - tools: List available tools
 * - cancel: Cancel a run
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
      cli: [
        {
          name: 'run',
          description: 'Run a prompt through the core runtime',
          handler: this.runCommand.bind(this),
        },
        {
          name: 'session',
          description: 'Create a new session',
          handler: this.sessionCommand.bind(this),
        },
        {
          name: 'inspect',
          description: 'Inspect a run by ID',
          handler: this.inspectCommand.bind(this),
        },
        {
          name: 'tools',
          description: 'List available tool specifications',
          handler: this.toolsCommand.bind(this),
        },
        {
          name: 'cancel',
          description: 'Cancel an active run by ID',
          handler: this.cancelCommand.bind(this),
        },
      ],
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

  // CLI command placeholders (thin wrappers over the API)

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
