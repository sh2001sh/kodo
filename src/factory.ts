import { RuntimeCore } from './core/runtime.js';
import type { RuntimeCoreOptions } from './core/runtime.js';
import type { ModelBinding, Provider } from './core/types.js';
import { PluginRegistry } from './plugin-registry.js';
import type { CapabilityPlugin } from './plugins/capability.js';
import type { IntegrationPlugin } from './plugins/integration.js';
import type { ToolPlugin } from './plugins/tool.js';

/**
 * Everything a runtime is made of. Only `provider` and `binding` are required; with no
 * plugins the result is a bare model loop with no tools.
 *
 * Phase 1 takes plugin instances. The standard library (file, shell, history,
 * compaction, ...) arrives as plugins in Phase 2 and is passed the same way.
 */
export interface RuntimeConfig extends RuntimeCoreOptions {
  /** Any `src/providers` adapter or a test double. */
  provider: Provider;
  /** Default model binding for new sessions. */
  binding: ModelBinding;
  capabilities?: readonly CapabilityPlugin[];
  tools?: readonly ToolPlugin[];
  integrations?: readonly IntegrationPlugin[];
}

export interface CreatedRuntime {
  runtime: RuntimeCore;
  registry: PluginRegistry;
  /** Cancels active runs, then cleans up plugins in reverse order. */
  shutdown(): Promise<void>;
}

/** Builds a core, registers the configured plugins and initialises them. */
export async function createRuntime(config: RuntimeConfig): Promise<CreatedRuntime> {
  const { provider, binding, capabilities = [], tools = [], integrations = [], ...options } = config;
  const runtime = new RuntimeCore(provider, binding, options);
  const registry = new PluginRegistry();
  for (const plugin of capabilities) registry.registerCapability(plugin);
  for (const plugin of tools) registry.registerTools(plugin);
  for (const plugin of integrations) registry.registerIntegration(plugin);
  await registry.initialize(runtime);
  return {
    runtime, registry,
    async shutdown() {
      await runtime.shutdown();
      await registry.cleanup();
    },
  };
}
