import type { RuntimeCore } from '../core/runtime.js';
import type { IntegrationPlugin } from '../plugins/integration.js';
import { createLocalServer } from '../web/server.js';
import type { LocalServerHandle, LocalServerOptions } from '../web/server.js';
import type { Application } from '../application/index.js';

/**
 * WebIntegrationPlugin exposes the workbench server as an integration.
 *
 * This is a thin wrapper: it delegates to src/web/server.ts and does not
 * reimplement the Application or HTTP protocol. Full migration of Application
 * to plugins is deferred until Phase 2 coordinator capabilities are ready.
 *
 * API interface:
 * - start(options): Start a local workbench server
 * - stop(handle): Stop a running server
 *
 * CLI interface:
 * - serve: Start the workbench server (placeholder)
 *
 * Dependencies:
 * - Application instance (not yet available in RuntimeCore)
 * - Store (for session/run persistence)
 *
 * @example
 * ```typescript
 * const plugin = new WebIntegrationPlugin();
 * const { runtime, registry } = await createRuntime({
 *   provider,
 *   binding,
 *   store,
 *   integrations: [plugin],
 * });
 *
 * const api = registry.integration('web').api;
 * const handle = await api.start({ workspace: './workspace', port: 3000 });
 * console.log(`Server started at ${handle.origin}`);
 * // ... use the server
 * await api.stop(handle);
 * ```
 */
export class WebIntegrationPlugin implements IntegrationPlugin {
  readonly kind = 'integration' as const;
  readonly name = 'web';
  readonly version = '0.1.0';

  private runtime!: RuntimeCore;
  private application?: Application;

  async initialize(runtime: RuntimeCore): Promise<void> {
    this.runtime = runtime;
    // TODO: Application not yet available in RuntimeCore
    // This will require Phase 2 coordinator plugin to provide Application
    // For now, this plugin is not functional until Application is added
  }

  getInterface() {
    return {
      api: {
        start: this.startServer.bind(this),
        stop: this.stopServer.bind(this),
      },
      cli: [
        {
          name: 'serve',
          description: 'Start the workbench server',
          handler: this.serveCommand.bind(this),
        },
      ],
    };
  }

  async cleanup(): Promise<void> {
    // Server cleanup handled by handle.close()
  }

  // API methods

  /**
   * Start a local workbench server.
   *
   * @param options - Server options
   * @returns Server handle with origin and close method
   *
   * @example
   * ```typescript
   * const handle = await api.start({
   *   workspace: './workspace',
   *   port: 3000,
   *   permissions: ['read', 'write'],
   * });
   * console.log(`Server at ${handle.origin}`);
   * await handle.close();
   * ```
   */
  async startServer(options: LocalServerOptions): Promise<LocalServerHandle> {
    if (!this.application) {
      throw new Error(
        'WebIntegrationPlugin.start requires an Application instance. ' +
        'Application is not yet available in RuntimeCore; this will be added when Phase 2 coordinator plugin is ready.'
      );
    }
    return await createLocalServer(this.application, options);
  }

  /**
   * Stop a running server.
   *
   * @param handle - Server handle from start()
   */
  async stopServer(handle: LocalServerHandle): Promise<void> {
    await handle.close();
  }

  // CLI command placeholder

  private readonly serveCommand: (args: Record<string, unknown>) => Promise<unknown> = async () => {
    throw new Error('CLI handler not yet implemented');
  };
}
