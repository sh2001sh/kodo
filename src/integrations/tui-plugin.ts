import type { RuntimeCore } from '../core/runtime.js';
import type { IntegrationPlugin } from '../plugins/integration.js';
import { runTui } from '../tui/index.js';
import type { TuiStreams } from '../tui/index.js';
import type { TuiActions } from '../tui/types.js';

/**
 * TuiIntegrationPlugin exposes the terminal UI (Ink-based) as an integration.
 *
 * This is a thin wrapper: it delegates to src/tui/index.tsx and does not
 * reimplement the TuiActions controller or the interactive terminal state.
 * Full migration of the controller to plugins is deferred until Phase 2
 * coordinator capabilities are ready.
 *
 * API interface:
 * - start(controller, streams?): Start the TUI with a controller
 *
 * CLI interface:
 * - chat: Start interactive TUI (placeholder)
 *
 * Dependencies:
 * - TuiActions controller (not yet available in RuntimeCore)
 * - Application instance (provides controller implementation)
 *
 * @example
 * ```typescript
 * const plugin = new TuiIntegrationPlugin();
 * const { runtime, registry } = await createRuntime({
 *   provider,
 *   binding,
 *   integrations: [plugin],
 * });
 *
 * const api = registry.integration('tui').api;
 * // controller would come from Application
 * await api.start(controller);
 * ```
 */
export class TuiIntegrationPlugin implements IntegrationPlugin {
  readonly kind = 'integration' as const;
  readonly name = 'tui';
  readonly version = '0.1.0';

  private runtime!: RuntimeCore;

  async initialize(runtime: RuntimeCore): Promise<void> {
    this.runtime = runtime;
    // TODO: TuiActions controller not yet available in RuntimeCore
    // This will require Phase 2 coordinator plugin to provide controller
    // For now, this plugin is not functional until controller is added
  }

  getInterface() {
    return {
      api: {
        start: this.startTui.bind(this),
      },
      cli: [
        {
          name: 'chat',
          description: 'Start interactive terminal UI',
          handler: this.chatCommand.bind(this),
        },
      ],
    };
  }

  async cleanup(): Promise<void> {
    // TUI cleanup handled by runTui itself
  }

  // API methods

  /**
   * Start the terminal UI with a controller.
   *
   * @param controller - TuiActions controller implementation
   * @param streams - Optional stdin/stdout/stderr streams
   *
   * @example
   * ```typescript
   * await api.start(controller, {
   *   stdin: process.stdin,
   *   stdout: process.stdout,
   *   stderr: process.stderr,
   * });
   * ```
   */
  async startTui(controller: TuiActions, streams?: TuiStreams): Promise<void> {
    await runTui(controller, streams);
  }

  // CLI command placeholder

  private readonly chatCommand: (args: Record<string, unknown>) => Promise<unknown> = async () => {
    throw new Error('CLI handler not yet implemented');
  };
}
