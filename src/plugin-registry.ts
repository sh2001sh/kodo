import { KodoError } from './runtime/types.js';
import type { RuntimeCore } from './core/runtime.js';
import type { CapabilityPlugin } from './plugins/capability.js';
import type { IntegrationInterface, IntegrationPlugin } from './plugins/integration.js';
import type { ToolPlugin } from './plugins/tool.js';

type Entry =
  | { kind: 'capability'; plugin: CapabilityPlugin }
  | { kind: 'tool'; plugin: ToolPlugin }
  | { kind: 'integration'; plugin: IntegrationPlugin };

/**
 * Holds the plugins chosen for one runtime and owns their lifecycle.
 *
 * Plugins initialise after everything in their `dependsOn`; otherwise in the order
 * capabilities, tools, integrations, then registration order. A missing dependency or a
 * cycle fails `initialize` before any plugin starts. Cleanup runs in reverse.
 * If any `initialize` throws, the plugins already initialised are cleaned up and the
 * error is rethrown, leaving no half-started runtime.
 */
export class PluginRegistry {
  private readonly entries: Entry[] = [];
  private initialized: Entry[] | undefined;

  registerCapability(plugin: CapabilityPlugin): this { return this.add({ kind: 'capability', plugin }); }
  registerTools(plugin: ToolPlugin): this { return this.add({ kind: 'tool', plugin }); }
  registerIntegration(plugin: IntegrationPlugin): this { return this.add({ kind: 'integration', plugin }); }

  async initialize(runtime: RuntimeCore): Promise<void> {
    if (this.initialized) throw new KodoError('REGISTRY_INITIALIZED', 'plugins are already initialised');
    const ordered = this.order();
    const done: Entry[] = [];
    this.initialized = done;
    try {
      for (const entry of ordered) {
        await entry.plugin.initialize?.(runtime);
        done.push(entry);
        if (entry.kind === 'capability') runtime.registerCapability(entry.plugin);
        else if (entry.kind === 'tool') runtime.registerTools(entry.plugin);
      }
    } catch (error) {
      await this.cleanup().catch(() => { /* The initialisation error is the reported cause. */ });
      throw error;
    }
  }

  /** Cleans up every initialised plugin even if some fail; failures are rethrown together. */
  async cleanup(): Promise<void> {
    const done = this.initialized ?? [];
    this.initialized = undefined;
    const failures: unknown[] = [];
    for (const entry of [...done].reverse()) {
      try { await entry.plugin.cleanup?.(); }
      catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'plugin cleanup failed');
  }

  /** The entry points of an initialised integration. */
  integration(name: string): IntegrationInterface {
    const entry = this.initialized?.find(item => item.kind === 'integration' && item.plugin.name === name);
    if (!entry || entry.kind !== 'integration') throw new KodoError('PLUGIN_NOT_FOUND', `integration ${name} is not initialised`);
    return entry.plugin.getInterface();
  }

  listAvailable(): { capabilities: string[]; tools: string[]; integrations: string[] } {
    const names = (kind: Entry['kind']): string[] => this.entries.filter(entry => entry.kind === kind).map(entry => entry.plugin.name);
    return { capabilities: names('capability'), tools: names('tool'), integrations: names('integration') };
  }

  /** Dependency order; ties keep kind order, then registration order. */
  private order(): Entry[] {
    const rank = { capability: 0, tool: 1, integration: 2 };
    const pending = [...this.entries].sort((a, b) => rank[a.kind] - rank[b.kind]);
    for (const entry of pending) for (const name of entry.plugin.dependsOn ?? []) {
      if (!pending.some(item => item.plugin.name === name)) throw new KodoError('PLUGIN_DEPENDENCY', `${entry.plugin.name} depends on ${name}, which is not registered`);
    }
    const ordered: Entry[] = [];
    while (pending.length) {
      const index = pending.findIndex(entry => (entry.plugin.dependsOn ?? []).every(name => ordered.some(item => item.plugin.name === name)));
      if (index < 0) throw new KodoError('PLUGIN_DEPENDENCY', `dependency cycle among ${pending.map(entry => entry.plugin.name).join(', ')}`);
      ordered.push(...pending.splice(index, 1));
    }
    return ordered;
  }

  private add(entry: Entry): this {
    if (this.initialized) throw new KodoError('REGISTRY_INITIALIZED', 'register plugins before initialisation');
    if (this.entries.some(item => item.kind === entry.kind && item.plugin.name === entry.plugin.name)) throw new KodoError('PLUGIN_CONFLICT', `${entry.kind} plugin ${entry.plugin.name} is already registered`);
    this.entries.push(entry);
    return this;
  }
}
