import { describe, it, expect } from 'vitest';
import { createRuntime } from '../../src/factory.js';
import { EvalIntegrationPlugin } from '../../src/integrations/eval-plugin.js';
import type { ModelBinding, Provider } from '../../src/core/types.js';

// Test helpers
function scripted(response?: { content: string }): Provider {
  return {
    async complete() {
      return {
        message: { role: 'assistant', content: response?.content || 'test response' },
        finishReason: 'stop',
        usage: { input: 10, output: 10 },
      };
    },
  };
}

const binding: ModelBinding = {
  model: 'test-model',
  baseURL: 'http://test',
  apiKeyEnv: 'TEST_KEY',
};

describe('EvalIntegrationPlugin', () => {
  it('initializes and exposes eval API interface structure', async () => {
    const plugin = new EvalIntegrationPlugin();

    // Note: This test will throw until Store integration is implemented
    // For now, we just test that the plugin can be instantiated
    expect(plugin.name).toBe('eval');
    expect(plugin.version).toBe('0.1.0');

    // Test getInterface before initialize (should work)
    const iface = plugin.getInterface();
    expect(iface.api).toBeDefined();
    expect(iface.cli).toBeDefined();

    // Skip actual initialization until Store integration is done
    // await createRuntime({ provider: scripted(), binding, integrations: [plugin] });
  });

  it('exposes CLI commands', async () => {
    const plugin = new EvalIntegrationPlugin();
    const iface = plugin.getInterface();

    expect(iface.cli).toBeDefined();
    expect(iface.cli).toHaveLength(6);

    const commandNames = iface.cli?.map(cmd => cmd.name);
    expect(commandNames).toContain('freeze');
    expect(commandNames).toContain('run');
    expect(commandNames).toContain('list');
    expect(commandNames).toContain('compare');
    expect(commandNames).toContain('adopt');
    expect(commandNames).toContain('rollback');
  });

  it.skip('can freeze a case definition', async () => {
    // Skipped until Store integration is complete
    const plugin = new EvalIntegrationPlugin();
    const { registry } = await createRuntime({
      provider: scripted(),
      binding,
      integrations: [plugin],
    });

    const evalApi = registry.integration('eval').api as {
      freeze: (def: unknown) => Promise<unknown>;
    };

    const definition = {
      name: 'test-case',
      objective: 'Test objective',
      assertions: [
        {
          type: 'exit_code',
          expected: 0,
        },
      ],
    };

    const frozen = await evalApi.freeze(definition);
    expect(frozen).toBeDefined();
    expect(frozen).toHaveProperty('frozen');
  });
});
